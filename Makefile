# OpenContext Network Development Makefile

.PHONY: help setup test build clean lint format demo contracts js python gateway install-deps

# Default target
help:
	@echo "OpenContext Network Development Commands"
	@echo ""
	@echo "Setup & Installation:"
	@echo "  make setup        Install all dependencies (Foundry, Node, Python)"
	@echo "  make install-deps Install project dependencies only"
	@echo ""
	@echo "Testing:"
	@echo "  make test         Run all tests (contracts, JS, Python, Gateway)"
	@echo "  make test-contracts  Run Foundry tests only"
	@echo "  make test-js      Run JavaScript tests only"
	@echo "  make test-python  Run Python tests only"
	@echo "  make test-gateway Run Gateway tests only"
	@echo ""
	@echo "Building:"
	@echo "  make build        Build all projects"
	@echo "  make build-js     Build JavaScript SDK"
	@echo "  make build-gateway Build Gateway"
	@echo ""
	@echo "Code Quality:"
	@echo "  make lint         Run all linters"
	@echo "  make format       Format all code"
	@echo "  make typecheck    Run type checking"
	@echo ""
	@echo "Development:"
	@echo "  make demo         Run end-to-end demo"
	@echo "  make gateway      Start gateway server"
	@echo "  make clean        Clean build artifacts"
	@echo ""
	@echo "Environment:"
	@echo "  make env-check    Validate environment configuration"
	@echo "  make env-example  Copy .env.example to .env"
	@echo ""
	@echo "Security:"
	@echo "  make slither      Run Slither security analysis"

# Setup commands
setup: install-foundry install-node install-python install-deps
	@echo "✅ Setup complete"

install-foundry:
	@if ! command -v forge >/dev/null 2>&1; then \
		echo "📦 Installing Foundry..."; \
		curl -L https://foundry.paradigm.xyz | bash; \
		foundryup; \
	else \
		echo "✅ Foundry already installed"; \
	fi

install-node:
	@if ! command -v node >/dev/null 2>&1; then \
		echo "❌ Node.js not found. Please install Node.js 20+"; \
		exit 1; \
	else \
		echo "✅ Node.js found: $$(node --version)"; \
	fi

install-python:
	@if ! command -v python3 >/dev/null 2>&1; then \
		echo "❌ Python 3 not found. Please install Python 3.11+"; \
		exit 1; \
	else \
		echo "✅ Python found: $$(python3 --version)"; \
	fi
	@if ! command -v poetry >/dev/null 2>&1; then \
		echo "📦 Installing Poetry..."; \
		curl -sSL https://install.python-poetry.org | python3 -; \
	else \
		echo "✅ Poetry already installed"; \
	fi

install-deps:
	@echo "📦 Installing dependencies..."
	@if [ -d "config" ]; then cd config && npm ci; fi
	@if [ -d "sdk/js" ]; then cd sdk/js && npm ci; fi
	@if [ -d "sdk/python" ]; then cd sdk/python && poetry install; fi
	@if [ -d "gateway" ]; then cd gateway && npm ci; fi
	@if [ -d "test/integration" ]; then cd test/integration && npm ci; fi
	@if [ -f "foundry.toml" ]; then forge install; fi

# Testing commands
test: test-contracts test-js test-python test-gateway test-integration
	@echo "✅ All tests completed"

test-contracts:
	@echo "🧪 Running Foundry tests..."
	@forge test -vv

test-js:
	@if [ -d "sdk/js" ]; then \
		echo "🧪 Running JavaScript tests..."; \
		cd sdk/js && npm test; \
	fi

test-python:
	@if [ -d "sdk/python" ]; then \
		echo "🧪 Running Python tests..."; \
		cd sdk/python && poetry run pytest; \
	fi

test-gateway:
	@if [ -d "gateway" ]; then \
		echo "🧪 Running Gateway tests..."; \
		cd gateway && npm test; \
	fi

test-integration:
	@if [ -d "test/integration" ]; then \
		echo "🧪 Running Integration tests..."; \
		cd test/integration && npm ci && npm test; \
	fi

# Building commands
build: build-js build-gateway
	@echo "✅ Build completed"

build-js:
	@if [ -d "sdk/js" ]; then \
		echo "🔨 Building JavaScript SDK..."; \
		cd sdk/js && npm run build; \
	fi

build-gateway:
	@if [ -d "gateway" ]; then \
		echo "🔨 Building Gateway..."; \
		cd gateway && npm run build; \
	fi

# Code quality commands
lint: lint-contracts lint-js lint-python lint-gateway
	@echo "✅ Linting completed"

lint-contracts:
	@echo "🔍 Linting Solidity contracts..."
	@forge fmt --check

lint-js:
	@if [ -d "sdk/js" ]; then \
		echo "🔍 Linting JavaScript..."; \
		cd sdk/js && npm run lint; \
	fi

lint-python:
	@if [ -d "sdk/python" ]; then \
		echo "🔍 Linting Python..."; \
		cd sdk/python && poetry run black --check . && poetry run ruff check .; \
	fi

lint-gateway:
	@if [ -d "gateway" ]; then \
		echo "🔍 Linting Gateway..."; \
		cd gateway && npm run lint; \
	fi

format: format-contracts format-js format-python format-gateway
	@echo "✅ Formatting completed"

format-contracts:
	@echo "🎨 Formatting Solidity contracts..."
	@forge fmt

format-js:
	@if [ -d "sdk/js" ]; then \
		echo "🎨 Formatting JavaScript..."; \
		cd sdk/js && npm run lint -- --fix; \
	fi

format-python:
	@if [ -d "sdk/python" ]; then \
		echo "🎨 Formatting Python..."; \
		cd sdk/python && poetry run black . && poetry run ruff check --fix .; \
	fi

format-gateway:
	@if [ -d "gateway" ]; then \
		echo "🎨 Formatting Gateway..."; \
		cd gateway && npm run lint -- --fix; \
	fi

typecheck:
	@if [ -d "config" ]; then \
		echo "🔍 Type checking Config..."; \
		cd config && npm run typecheck; \
	fi
	@if [ -d "sdk/js" ]; then \
		echo "🔍 Type checking JavaScript..."; \
		cd sdk/js && npm run typecheck; \
	fi
	@if [ -d "gateway" ]; then \
		echo "🔍 Type checking Gateway..."; \
		cd gateway && npm run typecheck; \
	fi
	@if [ -d "sdk/python" ]; then \
		echo "🔍 Type checking Python..."; \
		cd sdk/python && poetry run mypy opencontext; \
	fi

# Development commands
demo:
	@echo "🚀 Running end-to-end demo..."
	@node demo.js

demo-python:
	@echo "🐍 Running Python demo..."
	@python3 demo.py

# Security commands
slither:
	@if command -v slither >/dev/null 2>&1; then \
		echo "🔒 Running Slither security analysis..."; \
		slither contracts/ --exclude-informational --exclude-low; \
	else \
		echo "⚠️  Slither not found. Install with: pip install slither-analyzer"; \
	fi

# Cleanup commands
# Environment commands
env-check:
	@echo "🔍 Validating environment configuration..."
	@if [ -f ".env" ]; then \
		echo "✅ .env file found"; \
	else \
		echo "❌ .env file not found. Run 'make env-example' to create one."; \
		exit 1; \
	fi
	@if [ -d "config" ]; then \
		cd config && npm run typecheck; \
		echo "✅ Environment configuration is valid"; \
	fi

env-example:
	@if [ ! -f ".env" ]; then \
		cp .env.example .env; \
		echo "✅ Created .env from .env.example"; \
		echo "⚠️  Please edit .env with your actual values"; \
	else \
		echo "⚠️  .env already exists. Backup your current .env before overwriting."; \
	fi

clean:
	@echo "🧹 Cleaning build artifacts..."
	@rm -rf out/
	@rm -rf cache/
	@if [ -d "config" ]; then rm -rf config/dist/ config/node_modules/; fi
	@if [ -d "sdk/js" ]; then rm -rf sdk/js/dist/ sdk/js/node_modules/; fi
	@if [ -d "sdk/python" ]; then rm -rf sdk/python/dist/ sdk/python/.venv/; fi
	@if [ -d "gateway" ]; then rm -rf gateway/dist/ gateway/node_modules/; fi

# Development helpers
contracts:
	@echo "📋 Available contracts:"
	@find contracts -name "*.sol" -not -path "*/test/*" | sed 's/^/  /'

js:
	@if [ -d "sdk/js" ]; then \
		cd sdk/js && npm run dev; \
	fi

python:
	@if [ -d "sdk/python" ]; then \
		cd sdk/python && poetry shell; \
	fi

gateway:
	@echo "🚀 Starting Gateway server..."
	@if [ -d "gateway" ]; then \
		cd gateway && npm run dev; \
	else \
		echo "❌ Gateway directory not found"; \
	fi