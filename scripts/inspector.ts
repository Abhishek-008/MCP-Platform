import { createClient } from '@supabase/supabase-js';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

// --- Configuration ---
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);
const TOOL_ID = process.env.TOOL_ID!;
const REPO_URL = process.env.TARGET_REPO_URL!;
const START_CMD = process.env.START_CMD!;

const workDir = path.resolve('./temp_repo');

async function main() {
    try {
        console.log(`[Inspector] Processing ${REPO_URL}...`);

        // 1. Clean & Clone
        if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
        execSync(`git clone ${REPO_URL} ${workDir}`);

        // 2. UNIVERSAL INSTALLER LOGIC
        console.log('[Inspector] Detecting project type and installing dependencies...');

        // --- STRATEGY: NODE.JS ---
        if (fs.existsSync(path.join(workDir, 'package.json'))) {
            console.log('-> Detected Node.js project');

            // Check for Lockfiles to determine Package Manager
            if (fs.existsSync(path.join(workDir, 'pnpm-lock.yaml'))) {
                console.log('   Using pnpm...');
                execSync('npm install -g pnpm', { stdio: 'inherit' });
                execSync('pnpm install', { cwd: workDir, stdio: 'inherit' });
            }
            else if (fs.existsSync(path.join(workDir, 'yarn.lock'))) {
                console.log('   Using yarn...');
                // --non-interactive prevents hanging on prompts
                execSync('yarn install --non-interactive', { cwd: workDir, stdio: 'inherit' });
            }
            else if (fs.existsSync(path.join(workDir, 'bun.lockb'))) {
                console.log('   Using bun...');
                execSync('npm install -g bun', { stdio: 'inherit' });
                execSync('bun install', { cwd: workDir, stdio: 'inherit' });
            }
            else {
                console.log('   Using npm...');
                // Use 'install' instead of 'ci' to be more forgiving of broken lockfiles
                execSync('npm install', { cwd: workDir, stdio: 'inherit' });
            }

            // Auto-Build: If a build script exists, run it.
            // Many MCP servers (like Gmail) are TypeScript and MUST be built.
            const pkg = JSON.parse(fs.readFileSync(path.join(workDir, 'package.json'), 'utf-8'));
            if (pkg.scripts && pkg.scripts.build) {
                console.log('   Running build script...');
                // Detect which runner to use again
                const runner = fs.existsSync(path.join(workDir, 'pnpm-lock.yaml')) ? 'pnpm' :
                    fs.existsSync(path.join(workDir, 'yarn.lock')) ? 'yarn' :
                        fs.existsSync(path.join(workDir, 'bun.lockb')) ? 'bun' : 'npm';

                execSync(`${runner} run build`, { cwd: workDir, stdio: 'inherit' });
            }
        }

        // --- STRATEGY: PYTHON ---
        else if (fs.existsSync(path.join(workDir, 'pyproject.toml')) || fs.existsSync(path.join(workDir, 'requirements.txt'))) {
            console.log('-> Detected Python project');

            // Priority 1: UV (Fastest, modern standard)
            if (fs.existsSync(path.join(workDir, 'uv.lock'))) {
                console.log('   Using uv...');
                execSync('pip install uv', { stdio: 'inherit' });
                execSync('uv sync', { cwd: workDir, stdio: 'inherit' });
            }
            // Priority 2: Poetry
            else if (fs.existsSync(path.join(workDir, 'poetry.lock'))) {
                console.log('   Using poetry...');
                execSync('pip install poetry', { stdio: 'inherit' });
                execSync('poetry install', { cwd: workDir, stdio: 'inherit' });
            }
            // Priority 3: Standard PIP
            else {
                // Install "build" dependencies if pyproject exists
                if (fs.existsSync(path.join(workDir, 'pyproject.toml'))) {
                    console.log('   Installing via pyproject.toml...');
                    execSync('pip install .', { cwd: workDir, stdio: 'inherit' });
                }
                // Fallback to requirements.txt
                else if (fs.existsSync(path.join(workDir, 'requirements.txt'))) {
                    console.log('   Installing via requirements.txt...');
                    execSync('pip install -r requirements.txt', { cwd: workDir, stdio: 'inherit' });
                }
            }
        }
        else {
            console.log('-> No standard project structure found. Attempting to run raw...');
        }

        // 3. INTROSPECTION (Handshake)
        console.log(`[Inspector] Booting server with: "${START_CMD}"...`);

        // We pass 'workDir' as CWD so the server finds its own files
        const tools = await fetchToolsFromRunningServer(START_CMD, workDir);

        console.log(`[Inspector] Successfully discovered ${tools.length} tools.`);

        // 4. Save to DB
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
                bundle_path: 'GIT_CLONE_MODE'
            })
            .eq('id', TOOL_ID);

        console.log('[Inspector] Setup Complete!');

    } catch (err: any) {
        console.error('[Inspector] FAILED:', err.message);
        await supabase.from('tools').update({ status: 'failed', error_log: err.message }).eq('id', TOOL_ID);
        process.exit(1);
    }
}

// --- HELPER: MCP Handshake ---
function fetchToolsFromRunningServer(command: string, cwd: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const [cmd, ...args] = command.split(' ');

        console.log(`[Inspector] Spawning: ${cmd} ${args.join(' ')}`);

        // Use 'shell: true' to support commands like "python -m ..." or chained commands
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

                    // Step 2: Receive Initialize Response
                    if (json.id === 0 && json.result) {
                        const initNotification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n";
                        serverProcess.stdin.write(initNotification);

                        const toolsRequest = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n";
                        serverProcess.stdin.write(toolsRequest);
                        isInitialized = true;
                    }

                    // Step 3: Receive Tools
                    if (json.id === 1 && json.result && json.result.tools) {
                        resolve(json.result.tools);
                        serverProcess.kill();
                    }
                } catch (e) { }
            }
        });

        serverProcess.stderr.on('data', (data) => console.error(`[Server Log] ${data}`));

        // Step 1: Send Initialize
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

main();