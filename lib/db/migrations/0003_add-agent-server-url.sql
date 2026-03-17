-- Add agent_server_url column to interactive_session_runtimes
-- Stores the sandbox-agent server URL (port 2468) for process log retrieval
ALTER TABLE interactive_session_runtimes ADD COLUMN IF NOT EXISTS agent_server_url TEXT;
