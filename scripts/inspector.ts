import { createClient } from '@supabase/supabase-js';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';

// --- Configuration ---
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);
const TOOL_ID = process.env.TOOL_ID!;
const REPO_URL = process.env.TARGET_REPO_URL!;
const START_CMD = process.env.START_CMD!;

const workDir = path.resolve('./temp_repo');
const artifactPath = path.resolve('./artifact.zip');

async function main() {
    try {
        console.log(`[Inspector] Processing ${REPO_URL}...`);

        // 1. Clean & Clone
        if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
        if (fs.existsSync(artifactPath)) fs.unlinkSync(artifactPath);

        execSync(`git clone ${REPO_URL} ${workDir}`);

        // 2. Install Dependencies (Universal Logic)
        installDependencies(workDir);

        // 3. Introspection (Handshake)
        console.log(`[Inspector] Booting server with: "${START_CMD}"...`);
        const tools = await fetchToolsFromRunningServer(START_CMD, workDir);
        console.log(`[Inspector] Successfully discovered ${tools.length} tools.`);

        // 4. Packing (Create Zip)
        console.log('[Inspector] Creating Snapshot Artifact...');
        // We EXCLUDE node_modules to keep the zip small (under 50MB Supabase limit).
        // The Gateway will run 'npm install' or 'pip install' again.
        // This tradeoff is required for the Free Tier.
        await createZipArtifact(workDir, artifactPath, ['node_modules', '.git', '.venv', '__pycache__']);

        // 5. Upload to Supabase
        console.log('[Inspector] Uploading Snapshot...');
        const fileContent = fs.readFileSync(artifactPath);
        const storagePath = `snapshots/${TOOL_ID}.zip`;

        // Ensure bucket exists (or create it manually in dashboard if this fails)
        const { error: uploadError } = await supabase.storage
            .from('tool-bundles')
            .upload(storagePath, fileContent, { contentType: 'application/zip', upsert: true });

        if (uploadError) throw uploadError;

        // 6. Update Database
        const manifest = {
            generated_at: new Date().toISOString(),
            source: REPO_URL,
            start_command: START_CMD,
            tools: tools
        };

        await supabase
            .from('tools')
            .update({
                status: 'active',
                manifest: manifest,
                bundle_path: storagePath
            })
            .eq('id', TOOL_ID);

        console.log('[Inspector] Setup Complete!');

    } catch (err: any) {
        console.error('[Inspector] FAILED:', err.message);
        await supabase.from('tools').update({ status: 'failed', error_log: err.message }).eq('id', TOOL_ID);
        process.exit(1);
    }
}

// ---------------- HELPER FUNCTIONS ----------------

function installDependencies(cwd: string) {
    console.log('[Inspector] Detecting project type...');

    // NODE.JS
    if (fs.existsSync(path.join(cwd, 'package.json'))) {
        console.log('-> Detected Node.js project');

        if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) {
            execSync('npm install -g pnpm', { stdio: 'inherit' });
            execSync('pnpm install', { cwd, stdio: 'inherit' });
        }
        else if (fs.existsSync(path.join(cwd, 'yarn.lock'))) {
            execSync('yarn install --frozen-lockfile', { cwd, stdio: 'inherit' });
        }
        else {
            execSync('npm install', { cwd, stdio: 'inherit' });
        }

        // Build Step
        const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
        if (pkg.scripts && pkg.scripts.build) {
            console.log('   Running build script...');
            const runner = fs.existsSync(path.join(cwd, 'pnpm-lock.yaml')) ? 'pnpm' :
                fs.existsSync(path.join(cwd, 'yarn.lock')) ? 'yarn' : 'npm';
            execSync(`${runner} run build`, { cwd, stdio: 'inherit' });
        }
    }
    // PYTHON
    else if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'requirements.txt'))) {
        console.log('-> Detected Python project');

        if (fs.existsSync(path.join(cwd, 'uv.lock'))) {
            execSync('pip install uv', { stdio: 'inherit' });
            execSync('uv sync', { cwd, stdio: 'inherit' });
        } else {
            if (fs.existsSync(path.join(cwd, 'requirements.txt'))) {
                execSync('pip install -r requirements.txt', { cwd, stdio: 'inherit' });
            }
            if (fs.existsSync(path.join(cwd, 'pyproject.toml'))) {
                execSync('pip install .', { cwd, stdio: 'inherit' });
            }
        }
    }
}

function fetchToolsFromRunningServer(command: string, cwd: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const [cmd, ...args] = command.split(' ');

        // Spawn with shell:true to handle complex commands
        const serverProcess = spawn(cmd, args, { cwd, env: process.env, shell: true });

        let buffer = '';
        let isInitialized = false;

        serverProcess.stdout.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const json = JSON.parse(line);

                    // Handshake Step 2
                    if (json.id === 0 && json.result) {
                        const initNotification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n";
                        serverProcess.stdin.write(initNotification);

                        const toolsRequest = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n";
                        serverProcess.stdin.write(toolsRequest);
                        isInitialized = true;
                    }

                    // Handshake Step 3
                    if (json.id === 1 && json.result && json.result.tools) {
                        resolve(json.result.tools);
                        serverProcess.kill();
                    }
                } catch (e) { }
            }
        });

        serverProcess.stderr.on('data', (data) => console.error(`[Server Log] ${data}`));

        // Handshake Step 1
        const initRequest = JSON.stringify({
            jsonrpc: "2.0", id: 0, method: "initialize",
            params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "inspector", version: "1.0" } }
        }) + "\n";
        serverProcess.stdin.write(initRequest);

        setTimeout(() => {
            serverProcess.kill();
            reject(new Error("Timeout: Handshake failed (15s)"));
        }, 15000);
    });
}

function createZipArtifact(sourceDir: string, outPath: string, ignoreList: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        archive.on('error', (err) => reject(err));

        archive.pipe(output);

        // Glob pattern to match everything EXCEPT ignoreList
        archive.glob('**/*', {
            cwd: sourceDir,
            ignore: ignoreList.map(i => `**/${i}/**`),
            dot: true
        });

        archive.finalize();
    });
}

main();