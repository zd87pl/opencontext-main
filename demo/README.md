# OpenContext Demo Environment

This directory contains a complete demo environment for OpenContext, showcasing the full platform capabilities including content encryption, user authentication, micropayments, and AI agent integration.

## 🚀 Quick Start

### Automated Setup (Recommended)

```bash
# Run the interactive setup script
./setup-demo.sh
```

The setup script will:
- Check all prerequisites
- Configure the demo environment
- Build and start all services
- Seed demo data
- Provide service URLs and credentials

### Manual Setup

If you prefer manual control:

```bash
# Build all services
docker-compose -f docker-compose.demo.yml build

# Start core services
docker-compose -f docker-compose.demo.yml up -d postgres redis

# Wait for database initialization
sleep 10

# Start application services
docker-compose -f docker-compose.demo.yml up -d backend frontend wordpress blockchain-sim nginx

# Optional: Start monitoring
docker-compose -f docker-compose.demo.yml --profile monitoring up -d

# Optional: Seed demo data
docker-compose -f docker-compose.demo.yml --profile seeding up seeder
```

## 🌐 Service URLs

Once running, access the demo at:

- **Frontend Demo App**: http://localhost:3000
- **Backend API**: http://localhost:3001
- **WordPress Demo**: http://localhost:3002
- **Blockchain Simulator**: http://localhost:8545
- **Prometheus** (if enabled): http://localhost:9090
- **Grafana** (if enabled): http://localhost:3030

## 🔐 Demo Credentials

- **WordPress Admin**: `admin` / `demo_admin_2024`
- **Grafana Admin**: `admin` / `demo_grafana_2024`
- **Demo Users**: Check `demo/data/demo-logins.json` after seeding

## 📊 Demo Features

### Content Creation & Encryption
- Upload content with client-side AES-256-GCM encryption
- Automatic preview generation
- Platform integration (WordPress, GitHub, Medium)

### User Authentication
- OAuth integration (Google, GitHub, etc.)
- Managed wallet creation
- Session-based automatic decryption

### Payment System
- Stripe integration for fiat payments
- Mock USDC conversion
- Micropayment streaming (Superfluid simulation)
- Automatic access granting

### AI Agent Access
- MCP (Model Context Protocol) server
- Encrypted content serving
- Usage tracking and billing

## 🏗️ Architecture Overview

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│     Frontend    │    │    Backend      │    │   WordPress     │
│   (React App)  │◄───┤   (Node.js)     │◄───┤   (Demo Blog)   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
         ┌─────────────────┐    ┌─┴─────────────────┐    ┌─────────────────┐
         │   PostgreSQL    │    │      Redis        │    │  Blockchain     │
         │  (Database)     │    │   (Sessions)      │    │  (Simulator)    │
         └─────────────────┘    └───────────────────┘    └─────────────────┘
```

## 🔧 Configuration

### Environment Variables

Key configuration options (see `.env.demo`):

```bash
# Demo mode
DEMO_MODE=true
AUTO_SEED_DATA=true

# Database
DATABASE_URL=postgresql://opencontext:demo_password_2024@postgres:5432/opencontext_demo

# Authentication
JWT_SECRET=demo_jwt_secret_opencontext_2024_very_secure
SESSION_SECRET=demo_session_secret_opencontext_2024_very_secure

# Payments (Demo Stripe keys)
STRIPE_SECRET_KEY=sk_test_51234567890abcdefghijklmnopqrstuvwxyz
STRIPE_PUBLISHABLE_KEY=pk_test_51234567890abcdefghijklmnopqrstuvwxyz
```

### Docker Compose Profiles

- `default`: Core services (postgres, redis, backend, frontend, wordpress, nginx)
- `seeding`: Add demo data seeder
- `monitoring`: Add Prometheus and Grafana

## 📱 Demo Workflows

### 1. Content Creator Workflow
1. Sign up via OAuth (Google/GitHub)
2. Create encrypted content
3. Set pricing and publish
4. Monitor sales and analytics

### 2. Human Consumer Workflow
1. Browse content marketplace
2. Purchase content with Stripe
3. Automatic decryption and access
4. Rate and review content

### 3. AI Agent Workflow
1. Connect via MCP protocol
2. Browse available content
3. Stream micropayments for access
4. Process and utilize content

## 🧪 Testing the Demo

### Manual Testing Scenarios

1. **User Registration**: Test OAuth flows
2. **Content Upload**: Create and encrypt content
3. **Payment Flow**: Purchase content with Stripe
4. **Access Control**: Verify decryption works
5. **WordPress Integration**: Test plugin functionality
6. **API Access**: Use MCP server endpoints

### API Testing

```bash
# Health check
curl http://localhost:3001/health

# Search content
curl "http://localhost:3001/content/search?q=web3"

# Get content (requires auth)
curl -H "Authorization: Bearer TOKEN" \
     "http://localhost:3001/content/CONTENT_ID?decrypt=true"
```

## 🔍 Monitoring & Debugging

### View Logs
```bash
# All services
docker-compose -f docker-compose.demo.yml logs -f

# Specific service
docker-compose -f docker-compose.demo.yml logs -f backend
```

### Database Access
```bash
# Connect to PostgreSQL
docker-compose -f docker-compose.demo.yml exec postgres \
  psql -U opencontext -d opencontext_demo

# View tables
\dt

# Check demo data
SELECT COUNT(*) FROM users;
SELECT COUNT(*) FROM content;
SELECT COUNT(*) FROM purchases;
```

### Redis Inspection
```bash
# Connect to Redis
docker-compose -f docker-compose.demo.yml exec redis redis-cli

# View sessions
KEYS session:*
```

## 🛠️ Development

### Hot Reload Development

For active development, you can run services with hot reload:

```bash
# Backend development
cd backend
npm run dev

# Frontend development  
cd demo/frontend
npm start
```

### Custom Configuration

Override any service configuration by creating `docker-compose.override.yml`:

```yaml
version: '3.8'
services:
  backend:
    environment:
      LOG_LEVEL: debug
    volumes:
      - ./backend:/app
      - /app/node_modules
```

## 🧹 Cleanup

### Stop Demo
```bash
docker-compose -f docker-compose.demo.yml down
```

### Full Cleanup (including data)
```bash
docker-compose -f docker-compose.demo.yml down -v
docker system prune -f
```

## 🐛 Troubleshooting

### Common Issues

1. **Port Conflicts**: Change ports in `docker-compose.demo.yml`
2. **Memory Issues**: Increase Docker memory allocation
3. **Permission Errors**: Check file permissions in demo directories
4. **Database Connection**: Ensure PostgreSQL is healthy before starting backend

### Debug Mode

Enable debug logging:

```bash
# Set environment variable
export DEBUG=opencontext:*

# Or add to docker-compose
environment:
  DEBUG: "opencontext:*"
  LOG_LEVEL: debug
```

## 📚 Additional Resources

- [OpenContext Documentation](../docs/)
- [API Reference](../docs/api.md)
- [WordPress Plugin Guide](../wordpress-plugin/README.md)
- [MCP Server Documentation](../docs/mcp-server.md)

## 🤝 Contributing

This demo environment is continuously improved. To contribute:

1. Test new features in the demo
2. Update demo data and scenarios
3. Improve setup automation
4. Add monitoring and observability

## 📄 License

This demo environment is part of the OpenContext project and is licensed under the MIT License.