#!/bin/bash

# OpenContext Demo Environment Setup Script
# This script sets up a fully interactive demo environment with all required components

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Emojis for better UX
ROCKET="🚀"
CHECK="✅"
CROSS="❌"
INFO="ℹ️"
WARNING="⚠️"
GEAR="⚙️"
PACKAGE="📦"
DATABASE="🗄️"
GLOBE="🌐"
LOCK="🔒"

echo -e "${BLUE}${ROCKET} OpenContext Demo Environment Setup${NC}"
echo -e "${BLUE}================================================${NC}"
echo ""

# Function to print section headers
print_section() {
    echo -e "\n${PURPLE}$1${NC}"
    echo -e "${PURPLE}$(printf '%*s' ${#1} | tr ' ' '-')${NC}"
}

# Function to print info
print_info() {
    echo -e "${CYAN}${INFO} $1${NC}"
}

# Function to print success
print_success() {
    echo -e "${GREEN}${CHECK} $1${NC}"
}

# Function to print warning
print_warning() {
    echo -e "${YELLOW}${WARNING} $1${NC}"
}

# Function to print error
print_error() {
    echo -e "${RED}${CROSS} $1${NC}"
}

# Function to ask yes/no questions
ask_yes_no() {
    while true; do
        read -p "$(echo -e "${CYAN}$1 [y/N]: ${NC}")" yn
        case $yn in
            [Yy]* ) return 0;;
            [Nn]* | "" ) return 1;;
            * ) echo "Please answer yes or no.";;
        esac
    done
}

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check prerequisites
print_section "${GEAR} Checking Prerequisites"

MISSING_DEPS=()

if ! command_exists docker; then
    print_error "Docker is not installed"
    MISSING_DEPS+=("docker")
else
    print_success "Docker is installed"
fi

if ! command_exists docker-compose; then
    if ! docker compose version >/dev/null 2>&1; then
        print_error "Docker Compose is not installed"
        MISSING_DEPS+=("docker-compose")
    else
        print_success "Docker Compose is available (as docker compose)"
        COMPOSE_CMD="docker compose"
    fi
else
    print_success "Docker Compose is installed"
    COMPOSE_CMD="docker-compose"
fi

if ! command_exists node; then
    print_warning "Node.js not found - some local development features may not work"
else
    NODE_VERSION=$(node --version)
    print_success "Node.js is installed ($NODE_VERSION)"
fi

if [ ${#MISSING_DEPS[@]} -ne 0 ]; then
    print_error "Missing required dependencies: ${MISSING_DEPS[*]}"
    echo ""
    echo "Please install the missing dependencies and run this script again."
    echo ""
    echo "Installation instructions:"
    echo "- Docker: https://docs.docker.com/get-docker/"
    echo "- Docker Compose: https://docs.docker.com/compose/install/"
    exit 1
fi

# Configuration
print_section "${GEAR} Demo Configuration"

echo "This setup will create a complete OpenContext demo environment including:"
echo "• PostgreSQL database with demo data"
echo "• Redis for session management"
echo "• OpenContext backend API"
echo "• React frontend demo application"
echo "• WordPress instance with OpenContext plugin"
echo "• Blockchain simulator (mock zkSync/Base)"
echo "• Nginx reverse proxy"
echo "• Monitoring stack (Prometheus + Grafana) [optional]"
echo ""

if ! ask_yes_no "Do you want to proceed with the full demo setup?"; then
    echo "Setup cancelled."
    exit 0
fi

# Advanced options
SEED_DATA=true
MONITORING=false
HTTPS=false

echo ""
print_info "Advanced Configuration Options:"

if ask_yes_no "Enable monitoring stack (Prometheus + Grafana)?"; then
    MONITORING=true
    print_success "Monitoring stack will be enabled"
else
    print_info "Monitoring stack will be disabled"
fi

if ask_yes_no "Generate demo data (users, content, purchases)?"; then
    SEED_DATA=true
    print_success "Demo data seeding will be enabled"
else
    SEED_DATA=false
    print_info "Demo data seeding will be disabled"
fi

if ask_yes_no "Generate self-signed SSL certificate for HTTPS?"; then
    HTTPS=true
    print_success "HTTPS will be enabled"
else
    print_info "HTTPS will be disabled"
fi

# Create necessary directories
print_section "${PACKAGE} Creating Directory Structure"

DEMO_DIRS=(
    "demo/data"
    "demo/uploads"
    "demo/static"
    "demo/nginx/ssl"
    "demo/grafana/dashboards"
    "demo/wordpress/themes"
    "demo/wordpress/uploads"
)

for dir in "${DEMO_DIRS[@]}"; do
    if [ ! -d "$dir" ]; then
        mkdir -p "$dir"
        print_success "Created directory: $dir"
    else
        print_info "Directory already exists: $dir"
    fi
done

# Generate SSL certificate if requested
if [ "$HTTPS" = true ]; then
    print_section "${LOCK} Generating SSL Certificate"
    
    if [ ! -f "demo/nginx/ssl/demo.crt" ]; then
        openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
            -keyout demo/nginx/ssl/demo.key \
            -out demo/nginx/ssl/demo.crt \
            -subj "/C=US/ST=Demo/L=Demo/O=OpenContext/OU=Demo/CN=localhost"
        print_success "Generated self-signed SSL certificate"
    else
        print_info "SSL certificate already exists"
    fi
fi

# Create environment file
print_section "${GEAR} Creating Environment Configuration"

ENV_FILE=".env.demo"

cat > "$ENV_FILE" << EOF
# OpenContext Demo Environment Configuration
# Generated on $(date)

# Application
NODE_ENV=production
DEMO_MODE=true
AUTO_SEED_DATA=$SEED_DATA

# Database
DATABASE_URL=postgresql://opencontext:demo_password_2024@postgres:5432/opencontext_demo
POSTGRES_DB=opencontext_demo
POSTGRES_USER=opencontext
POSTGRES_PASSWORD=demo_password_2024

# Redis
REDIS_URL=redis://:demo_redis_2024@redis:6379

# JWT & Sessions
JWT_SECRET=demo_jwt_secret_opencontext_2024_very_secure
SESSION_SECRET=demo_session_secret_opencontext_2024_very_secure

# Wallet Encryption
WALLET_ENCRYPTION_KEY=abcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234

# Stripe (Demo Keys)
STRIPE_SECRET_KEY=sk_test_51234567890abcdefghijklmnopqrstuvwxyz
STRIPE_WEBHOOK_SECRET=whsec_demo_webhook_secret_2024
STRIPE_PUBLISHABLE_KEY=pk_test_51234567890abcdefghijklmnopqrstuvwxyz

# OAuth (Demo Configuration)
GOOGLE_CLIENT_ID=demo_google_client_id.googleusercontent.com
GOOGLE_CLIENT_SECRET=demo_google_client_secret
GITHUB_CLIENT_ID=demo_github_client_id
GITHUB_CLIENT_SECRET=demo_github_client_secret

# CORS
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3002,http://localhost:80

# Blockchain
BLOCKCHAIN_RPC_URL=http://blockchain-sim:8545
PASSPORT_REGISTRY_ADDRESS=0x1234567890123456789012345678901234567890
CONTEXT_VAULT_ADDRESS=0x2345678901234567890123456789012345678901
PAYMENT_STREAM_ADDRESS=0x3456789012345678901234567890123456789012

# Demo Configuration
DEMO_USERS_COUNT=10
DEMO_CONTENT_COUNT=50
DEMO_PURCHASES_COUNT=100

# Monitoring
ENABLE_MONITORING=$MONITORING
ENABLE_HTTPS=$HTTPS
EOF

print_success "Created environment configuration: $ENV_FILE"

# Create Docker Compose profiles
COMPOSE_PROFILES=""
if [ "$MONITORING" = true ]; then
    COMPOSE_PROFILES="$COMPOSE_PROFILES --profile monitoring"
fi
if [ "$SEED_DATA" = true ]; then
    COMPOSE_PROFILES="$COMPOSE_PROFILES --profile seeding"
fi

# Build and start services
print_section "${PACKAGE} Building and Starting Demo Environment"

print_info "Building Docker images..."
$COMPOSE_CMD -f docker-compose.demo.yml build

print_info "Starting core services..."
$COMPOSE_CMD -f docker-compose.demo.yml up -d postgres redis

print_info "Waiting for database to be ready..."
sleep 10

print_info "Starting backend and supporting services..."
$COMPOSE_CMD -f docker-compose.demo.yml up -d backend blockchain-sim

print_info "Waiting for backend to be ready..."
sleep 15

print_info "Starting frontend and proxy..."
$COMPOSE_CMD -f docker-compose.demo.yml up -d frontend wordpress nginx

# Start optional services
if [ "$MONITORING" = true ]; then
    print_info "Starting monitoring stack..."
    $COMPOSE_CMD -f docker-compose.demo.yml --profile monitoring up -d
fi

# Seed demo data
if [ "$SEED_DATA" = true ]; then
    print_info "Seeding demo data..."
    $COMPOSE_CMD -f docker-compose.demo.yml --profile seeding up seeder
    $COMPOSE_CMD -f docker-compose.demo.yml --profile seeding rm -f seeder
fi

print_section "${CHECK} Demo Environment Ready!"

echo ""
print_success "OpenContext demo environment is now running!"
echo ""

# Service URLs
echo -e "${BLUE}${GLOBE} Service URLs:${NC}"
echo "• Frontend Demo App:     http://localhost:3000"
echo "• Backend API:           http://localhost:3001"
echo "• WordPress Demo:        http://localhost:3002"
echo "• Blockchain Simulator:  http://localhost:8545"

if [ "$HTTPS" = true ]; then
    echo "• HTTPS Frontend:        https://localhost"
fi

if [ "$MONITORING" = true ]; then
    echo "• Prometheus:            http://localhost:9090"
    echo "• Grafana:               http://localhost:3030 (admin/demo_grafana_2024)"
fi

echo ""

# Demo credentials
if [ "$SEED_DATA" = true ]; then
    echo -e "${BLUE}${LOCK} Demo Credentials:${NC}"
    echo "• WordPress Admin:       admin / demo_admin_2024"
    echo "• Demo user tokens available in: demo/data/demo-logins.json"
    echo ""
fi

# Next steps
echo -e "${BLUE}${INFO} Next Steps:${NC}"
echo "1. Open http://localhost:3000 to access the demo application"
echo "2. Try creating an account and uploading content"
echo "3. Test the payment flow and content access"
echo "4. Check the WordPress integration at http://localhost:3002"
echo ""

# Management commands
echo -e "${BLUE}${GEAR} Management Commands:${NC}"
echo "• View logs:     $COMPOSE_CMD -f docker-compose.demo.yml logs -f [service]"
echo "• Stop demo:     $COMPOSE_CMD -f docker-compose.demo.yml down"
echo "• Restart:       $COMPOSE_CMD -f docker-compose.demo.yml restart"
echo "• Clean up:      $COMPOSE_CMD -f docker-compose.demo.yml down -v"
echo ""

# Health check
print_info "Running health checks..."
sleep 5

HEALTH_CHECKS=(
    "http://localhost:3001/health|Backend API"
    "http://localhost:3000|Frontend"
    "http://localhost:8545/health|Blockchain Simulator"
)

for check in "${HEALTH_CHECKS[@]}"; do
    IFS='|' read -r url name <<< "$check"
    if curl -s -f "$url" > /dev/null 2>&1; then
        print_success "$name is healthy"
    else
        print_warning "$name may not be ready yet"
    fi
done

echo ""
print_success "Demo setup completed successfully! ${ROCKET}"

# Optional: Open browser
if command_exists open; then  # macOS
    if ask_yes_no "Open demo application in browser?"; then
        open http://localhost:3000
    fi
elif command_exists xdg-open; then  # Linux
    if ask_yes_no "Open demo application in browser?"; then
        xdg-open http://localhost:3000
    fi
fi

echo ""
echo -e "${CYAN}Happy demo-ing! 🎉${NC}"