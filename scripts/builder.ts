// scripts/builder.ts
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import * as esbuild from 'esbuild';

// 1. Setup Supabase
const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_KEY!
);

const TOOL_ID = process.env.TOOL_ID!;
const REPO_URL = process.env.TARGET_REPO_URL!;

async function main() {
    try {
        console.log(`[Builder] Processing Tool ID: ${TOOL_ID}`);

        // 2. Clone the User's Repo
        const workDir = path.resolve('./temp_build');
        if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });

        console.log(`[Builder] Cloning ${REPO_URL}...`);
        execSync(`git clone ${REPO_URL} ${workDir}`);

        // 3. Security Check (Basic "Trivy" Simulation)
        // In a real app, you would run the actual trivy binary here.
        console.log('[Builder] Running Security Scan...');
        const fileContent = fs.readFileSync(path.join(workDir, 'package.json'), 'utf-8');
        if (fileContent.includes('"malicious-package"')) { // Example check
            throw new Error('Security Violation: Banned dependency detected.');
        }

        // 4. Extract Manifest
        // We assume the user has a 'manifest.json' in root
        const manifestPath = path.join(workDir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
            throw new Error('Manifest.json missing in repository root.');
        }
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

        // 5. Bundle the Code (using esbuild)
        // We assume the entry point is 'index.ts' or 'index.js'
        console.log('[Builder] Bundling code...');
        const entryPoint = fs.existsSync(path.join(workDir, 'index.ts'))
            ? path.join(workDir, 'index.ts')
            : path.join(workDir, 'index.js');

        const outfile = path.join(workDir, 'bundle.js');

        await esbuild.build({
            entryPoints: [entryPoint],
            bundle: true,
            platform: 'node',
            outfile: outfile,
            // Security: Externalize built-ins so they aren't polyfilled dangerously
            external: ['fs', 'path', 'os', 'child_process'],
        });

        // 6. Upload to Supabase Storage
        console.log('[Builder] Uploading artifact...');
        const bundleContent = fs.readFileSync(outfile);
        const storagePath = `bundles/${TOOL_ID}.js`;

        const { error: uploadError } = await supabase.storage
            .from('tool-bundles')
            .upload(storagePath, bundleContent, { contentType: 'text/javascript', upsert: true });

        if (uploadError) throw uploadError;

        // 7. Mark as Complete
        console.log('[Builder] Success! Updating DB...');
        await supabase
            .from('tools')
            .update({
                status: 'active',
                manifest: manifest,
                bundle_path: storagePath
            })
            .eq('id', TOOL_ID);

    } catch (err: any) {
        console.error('[Builder] FAILED:', err.message);

        // Write failure to DB
        await supabase
            .from('tools')
            .update({
                status: 'failed',
                error_log: err.message
            })
            .eq('id', TOOL_ID);

        process.exit(1);
    }
}

main();