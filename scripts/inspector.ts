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
        console.log('[Inspector] Installing dependencies...');

        if (fs.existsSync(path.join(workDir, 'package.json'))) {
            // Node.js Strategy
            console.log('-> Detected Node.js project');
            execSync('npm install --production', { cwd: workDir, stdio: 'inherit' });

            // Optional: Build if there is a build script
            const pkg = JSON.parse(fs.readFileSync(path.join(workDir, 'package.json'), 'utf-8'));
            if (pkg.scripts && pkg.scripts.build) {
                execSync('npm run build', { cwd: workDir, stdio: 'inherit' });
            }

        } else if (fs.existsSync(path.join(workDir, 'requirements.txt')) || fs.existsSync(path.join(workDir, 'pyproject.toml'))) {
            // Python Strategy
            console.log('-> Detected Python project');
            execSync('pip install -r requirements.txt', { cwd: workDir, stdio: 'inherit' });
        } else {
            console.log('-> No standard dependency file found. Assuming standalone script.');
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

        // Spawn the server process
        const serverProcess = spawn(cmd, args, { cwd, env: process.env });

        let buffer = '';
        let toolsFound = false;

        // Listen to STDOUT (Server responses)
        serverProcess.stdout.on('data', (data) => {
            buffer += data.toString();

            // Try to parse JSON-RPC messages from the stream
            const lines = buffer.split('\n');
            for (const line of lines) {
                try {
                    const json = JSON.parse(line);
                    // Check if this is the response to our request
                    if (json.id === 1 && json.result && json.result.tools) {
                        toolsFound = true;
                        resolve(json.result.tools);
                        serverProcess.kill(); // We got what we came for
                    }
                } catch (e) {
                    // Ignore partial JSON lines
                }
            }
        });

        // Listen to STDERR (Debugging)
        serverProcess.stderr.on('data', (data) => console.error(`[Server Log] ${data}`));

        // Send the "listTools" request immediately after spawn
        const request = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list"
        }) + "\n"; // Newline is crucial for stdio transport!

        serverProcess.stdin.write(request);

        // Timeout Safety (5 seconds)
        setTimeout(() => {
            if (!toolsFound) {
                serverProcess.kill();
                reject(new Error("Timeout: Server did not respond to tools/list within 5s"));
            }
        }, 5000);

        serverProcess.on('error', (err) => reject(new Error(`Failed to start process: ${err.message}`)));
    });
}

main();