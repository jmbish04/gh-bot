-- Migration to create and populate a table for default research queries

CREATE TABLE IF NOT EXISTS default_queries (
id INTEGER PRIMARY KEY AUTOINCREMENT,
category TEXT NOT NULL,
query TEXT NOT NULL,
is_active BOOLEAN DEFAULT 1,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Clear existing entries to ensure a fresh start
DELETE FROM default_queries;

-- Populate with new default queries categorized for better management
INSERT INTO default_queries (category, query) VALUES
('Cloudflare Workers', 'topic:cloudflare-workers'),
('Cloudflare Workers', '"wrangler.toml" path:/'),
('Cloudflare Workers', '"DurableObject" language:typescript'),
('Cloudflare Workers', '"[[d1_databases]]" wrangler.toml'),
('Cloudflare Workers', '"@cloudflare/ai" language:typescript'),
('Cloudflare Workers', '"scheduled(event" language:typescript'),

('Cloudflare Pages', 'topic:cloudflare-pages'),
('Cloudflare Pages', '"functions" "_worker.js"'),
('Cloudflare Pages', '"next-on-pages"'),

('Cloudflare AI', 'topic:cloudflare-ai'),
('Cloudflare AI', '@cf/meta/llama-2-7b-chat-int8'),

('Python', 'language:python topic:python'),
('Python AI', 'language:python topic:pytorch'),
('Python AI', 'language:python topic:tensorflow'),
('Python AI', 'language:python topic:langchain'),

('JavaScript/TypeScript', 'topic:typescript'),
('JavaScript/TypeScript', 'topic:javascript'),
('JavaScript/TypeScript', '"import { Hono" language:typescript'),

('Frontend Libraries', 'topic:shadcn'),
('Frontend Libraries', 'topic:react'),
('Frontend Libraries', 'topic:vue'),
('Frontend Libraries', 'topic:svelte'),

('Awesome Lists', '"awesome list" in:name,description');
