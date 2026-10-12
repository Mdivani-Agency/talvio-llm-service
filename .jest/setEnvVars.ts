// Tests build their own config and dependencies; nothing reads the real environment.
process.env.STAGE ??= 'test';
process.env.SUPABASE_URL ??= 'https://project.supabase.example';
