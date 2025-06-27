-- Initialize PostgreSQL for OpenContext Demo

-- Create additional database for WordPress
CREATE DATABASE wordpress_demo;

-- Grant permissions
GRANT ALL PRIVILEGES ON DATABASE opencontext_demo TO opencontext;
GRANT ALL PRIVILEGES ON DATABASE wordpress_demo TO opencontext;

-- Initialize demo data
\c opencontext_demo;

-- Create extension for UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Demo configuration table
CREATE TABLE IF NOT EXISTS demo_config (
    key VARCHAR(255) PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert demo configuration
INSERT INTO demo_config (key, value) VALUES
    ('demo_mode', 'true'),
    ('seed_timestamp', CURRENT_TIMESTAMP::text),
    ('version', '1.0.0')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Log initialization
INSERT INTO demo_config (key, value) VALUES
    ('initialized_at', CURRENT_TIMESTAMP::text)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;