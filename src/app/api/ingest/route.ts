import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
    try {
        // 1. Parse Request (Added startCommand)
        const { repoUrl, userId, startCommand } = await req.json();

        if (!repoUrl || !repoUrl.startsWith('https://github.com/')) {
            return NextResponse.json({ error: 'Invalid GitHub URL' }, { status: 400 });
        }

        if (!startCommand) {
            return NextResponse.json({ error: 'Start command is required (e.g., "node index.js")' }, { status: 400 });
        }

        console.log(`[Ingest] Starting ingestion for: ${repoUrl}`);

        // 2. Insert into DB (Added start_command)
        // Make sure you ran the SQL to add the 'start_command' column!
        const { data: tool, error: dbError } = await supabaseAdmin
            .from('tools')
            .insert({
                user_id: userId,
                repo_url: repoUrl,
                start_command: startCommand, // <--- Saving to DB
                status: 'pending'
            })
            .select()
            .single();

        if (dbError) {
            console.error('DB Error:', dbError);
            return NextResponse.json({ error: 'Database Insert Failed' }, { status: 500 });
        }

        // 3. Trigger GitHub Action (Pass start_command in payload)
        const [owner, repo] = process.env.GITHUB_PLATFORM_REPO!.split('/');

        const githubResponse = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/dispatches`,
            {
                method: 'POST',
                headers: {
                    'Accept': 'application/vnd.github.v3+json',
                    'Authorization': `Bearer ${process.env.GITHUB_PAT}`,
                    'User-Agent': 'mcp-platform-ingestor',
                },
                body: JSON.stringify({
                    event_type: 'ingest_tool',
                    client_payload: {
                        tool_id: tool.id,
                        repo_url: repoUrl,
                        start_command: startCommand // <--- Passing to GitHub Action
                    }
                })
            }
        );

        if (!githubResponse.ok) {
            const ghError = await githubResponse.text();
            console.error('GitHub API Error:', ghError);
            return NextResponse.json({ error: 'Failed to trigger build worker' }, { status: 500 });
        }

        return NextResponse.json({
            success: true,
            toolId: tool.id,
            message: 'Build queued successfully'
        });

    } catch (error) {
        console.error('Server Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}