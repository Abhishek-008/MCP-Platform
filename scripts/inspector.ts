import { createClient } from '@supabase/supabase-js';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

// --- Configuration ---
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);
const TOOL_ID = process.env.TOOL_ID!;
const REPO_URL = process.env.TARGET_REPO_URL!;
const START_CMD = process.env.START_CMD!; // <--- New Input from User

const workDir = path.resolve('./temp_repo');



async function main() {
    try {
        console.log(`[Inspector] Processing ${REPO_URL}...`);

        // 1. Clean & Clone
        if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
        execSync(`git clone ${REPO_URL} ${workDir}`);

        // 2. Detect Type & Install Dependencies
        console.log('[Inspector] Detecting project type...');

        // NODE.JS STRATEGY
        if (fs.existsSync(path.join(workDir, 'package.json'))) {
            console.log('-> Detected Node.js project');

            if (fs.existsSync(path.join(workDir, 'pnpm-lock.yaml'))) {
                console.log('   Using pnpm...');
                execSync('npm install -g pnpm', { stdio: 'inherit' });
                execSync('pnpm install --prod', { cwd: workDir, stdio: 'inherit' });
            } else if (fs.existsSync(path.join(workDir, 'yarn.lock'))) {
                console.log('   Using yarn...');
                execSync('yarn install --production', { cwd: workDir, stdio: 'inherit' });
            } else {
                console.log('   Using npm...');
                execSync('npm ci --omit=dev', { cwd: workDir, stdio: 'inherit' });
            }

            // Build step (if needed)
            const pkg = JSON.parse(fs.readFileSync(path.join(workDir, 'package.json'), 'utf-8'));
            if (pkg.scripts && pkg.scripts.build) {
                // Detect build system
                const cmd = fs.existsSync(path.join(workDir, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
                execSync(`${cmd} run build`, { cwd: workDir, stdio: 'inherit' });
            }
        }
        // PYTHON STRATEGY
        else if (fs.existsSync(path.join(workDir, 'pyproject.toml')) || fs.existsSync(path.join(workDir, 'requirements.txt'))) {
            console.log('-> Detected Python project');

            // Check for 'uv' usage (preferred for speed/reliability)
            if (fs.existsSync(path.join(workDir, 'uv.lock'))) {
                console.log('   Using uv...');
                execSync('pip install uv', { stdio: 'inherit' });
                execSync('uv sync', { cwd: workDir, stdio: 'inherit' });
            } else {
                // Fallback to standard pip
                if (fs.existsSync(path.join(workDir, 'requirements.txt'))) {
                    execSync('pip install -r requirements.txt', { cwd: workDir, stdio: 'inherit' });
                }
                if (fs.existsSync(path.join(workDir, 'pyproject.toml'))) {
                    execSync('pip install .', { cwd: workDir, stdio: 'inherit' });
                }
            }
        }

        // 3. INTROSPECTION (The Magic Step)
        console.log(`[Inspector] Booting server with: "${START_CMD}" to extract tools...`);

        const tools = await fetchToolsFromRunningServer(START_CMD, workDir);

        console.log(`[Inspector] Successfully discovered ${tools.length} tools.`);

        // 4. Create the "Golden Record" (Manifest)
        const manifest = {
            generated_at: new Date().toISOString(),
            source: REPO_URL,
            start_command: START_CMD,
            tools: tools // We explicitly store the discovered tools
        };

        // 5. Upload to DB
        // Note: In a $0 build, we might just store the manifest and clone-on-demand at runtime 
        // instead of creating a huge bundle artifact, unless you strictly need single-file bundles.
        await supabase
            .from('tools')
            .update({
                status: 'active',
                manifest: manifest,
                // For now, we assume we just clone the repo at runtime since we support multiple languages
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

// Helper: Starts the server, sends "tools/list", and kills it.
function fetchToolsFromRunningServer(command: string, cwd: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const [cmd, ...args] = command.split(' ');

        console.log(`[Inspector] Spawning: ${cmd} ${args.join(' ')}`);
        const serverProcess = spawn(cmd, args, { cwd, env: process.env });

        let buffer = '';
        let isInitialized = false;

        // Listen to STDOUT (Server responses)
        serverProcess.stdout.on('data', (data) => {
            buffer += data.toString();

            // Process buffer line by line
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep the last partial line in buffer

            for (const line of lines) {
                if (!line.trim()) continue;

                try {
                    const json = JSON.parse(line);

                    // STEP 2: Receive Initialize Response
                    if (json.id === 0 && json.result) {
                        console.log('[Inspector] Handshake Step 2: Server initialized.');

                        // STEP 3: Send "initialized" notification
                        const initNotification = JSON.stringify({
                            jsonrpc: "2.0",
                            method: "notifications/initialized"
                        }) + "\n";
                        serverProcess.stdin.write(initNotification);

                        // STEP 4: Ask for Tools
                        console.log('[Inspector] Handshake Step 4: Requesting tools...');
                        const toolsRequest = JSON.stringify({
                            jsonrpc: "2.0",
                            id: 1,
                            method: "tools/list"
                        }) + "\n";
                        serverProcess.stdin.write(toolsRequest);
                        isInitialized = true;
                    }

                    // STEP 5: Receive Tools
                    if (json.id === 1 && json.result && json.result.tools) {
                        console.log(`[Inspector] Success! Found ${json.result.tools.length} tools.`);
                        resolve(json.result.tools);
                        serverProcess.kill();
                    }

                } catch (e) {
                    // Ignore non-JSON lines (like logs)
                }
            }
        });

        // Listen to STDERR (Debugging)
        serverProcess.stderr.on('data', (data) => console.error(`[Server Log] ${data}`));

        // STEP 1: Send Initialize Request immediately
        console.log('[Inspector] Handshake Step 1: Sending initialize...');
        const initRequest = JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "mcp-inspector", version: "1.0.0" }
            }
        }) + "\n";
        serverProcess.stdin.write(initRequest);

        // Timeout Safety (10 seconds)
        setTimeout(() => {
            serverProcess.kill();
            reject(new Error("Timeout: Server did not complete handshake within 10s"));
        }, 10000);

        serverProcess.on('error', (err) => reject(new Error(`Failed to start process: ${err.message}`)));
    });
}

main();