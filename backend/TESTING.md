# OpenContext Backend Testing Guide

This document outlines the comprehensive test suite for the OpenContext backend implementation.

## Test Structure

The test suite covers all critical components of the PoC implementation:

```
backend/src/
├── __tests__/
│   ├── setup.ts              # Global test configuration
│   └── integration.test.ts   # End-to-end integration tests
├── auth/__tests__/
│   └── auth.middleware.test.ts
├── content/__tests__/
│   ├── encryption.service.test.ts
│   ├── key-escrow.service.test.ts
│   ├── auto-decrypt.middleware.test.ts
│   └── content.router.test.ts
└── payments/__tests__/
    └── payment.service.test.ts
```

## Test Categories

### 1. Unit Tests

#### Encryption Service (`encryption.service.test.ts`)
- ✅ **Content Key Generation**: Validates 256-bit key generation and uniqueness
- ✅ **AES-256-GCM Encryption/Decryption**: Tests encryption integrity and tamper detection
- ✅ **Content Key Encryption for Users**: Session-based key protection
- ✅ **Preview Generation**: Content truncation and formatting
- ✅ **Content Hash Verification**: SHA-256 integrity checking
- ✅ **Client-Side Encryption Simulation**: Complete encryption workflow
- ✅ **Error Handling**: Invalid inputs, corrupted data, unicode support
- ✅ **Performance**: Large content encryption (1MB test)

#### Key Escrow Service (`key-escrow.service.test.ts`)
- ✅ **Session Key Management**: Generation, storage, and expiration
- ✅ **Content Key Storage**: Encrypted key storage in database
- ✅ **Access Retrieval**: Key retrieval with access verification
- ✅ **Grant/Revoke Access**: Content access management
- ✅ **Cleanup Operations**: Expired record removal
- ✅ **Concurrent Access**: Multiple session key requests
- ✅ **Error Scenarios**: Database failures, invalid data formats

#### Authentication Middleware (`auth.middleware.test.ts`)
- ✅ **JWT Token Validation**: Token verification and user lookup
- ✅ **Optional Authentication**: Graceful handling of missing tokens
- ✅ **Session Authentication**: Passport.js integration
- ✅ **Error Handling**: Invalid tokens, missing secrets, database errors
- ✅ **Request Enhancement**: User and userId injection

#### Payment Service (`payment.service.test.ts`)
- ✅ **Payment Intent Creation**: Stripe integration and metadata handling
- ✅ **Payment Processing**: Successful and failed payment flows
- ✅ **Webhook Handling**: Stripe event processing
- ✅ **Access Verification**: Purchase-based content access
- ✅ **User Purchase History**: Purchase record management
- ✅ **Decimal Conversion**: Proper currency handling
- ✅ **Blockchain Integration**: Mock USDC transfer simulation

#### Auto-Decrypt Middleware (`auto-decrypt.middleware.test.ts`)
- ✅ **Session Setup**: Automatic session key creation
- ✅ **Content Decryption**: Response interception and decryption
- ✅ **Access Control**: Permission-based decryption
- ✅ **Error Graceful Handling**: Failed decryption scenarios
- ✅ **Manual Decryption**: Direct content decryption API
- ✅ **Cleanup Operations**: Session key management

### 2. Integration Tests

#### Content Router (`content.router.test.ts`)
- ✅ **Content Creation API**: POST /api/content/create
- ✅ **Content Retrieval**: GET /api/content/:contentId with optional decryption
- ✅ **User Content Listing**: GET /api/content/user/:userId
- ✅ **Accessible Content**: GET /api/content/my/accessible
- ✅ **Content Search**: GET /api/content/search with filters
- ✅ **Client Library**: GET /api/content/lib/encryption.js
- ✅ **Authentication Requirements**: Proper middleware enforcement
- ✅ **Error Handling**: Database and service failures

#### End-to-End Flow (`integration.test.ts`)
- ✅ **Complete Monetization Flow**: Content creation → Payment → Access
- ✅ **Payment Failure Handling**: Failed payment scenarios
- ✅ **Access Denial**: Unpaid content protection
- ✅ **Encryption Security**: IV uniqueness, tamper detection
- ✅ **Performance**: Concurrent operations
- ✅ **Error Recovery**: Database and API failures

## Running Tests

### Prerequisites
```bash
cd backend
npm install
```

### Test Commands
```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm test encryption.service.test.ts

# Run tests in watch mode
npm run test:watch

# Run integration tests only
npm test integration.test.ts
```

### Environment Setup
Tests use mocked dependencies and don't require actual database or external services:
- **Database**: Mocked Prisma client
- **Stripe**: Mocked Stripe SDK
- **Redis**: In-memory session storage
- **Blockchain**: Mocked wallet operations

## Test Coverage Goals

- **Unit Tests**: ≥90% coverage for core services
- **Integration Tests**: ≥80% coverage for API endpoints
- **Critical Paths**: 100% coverage for payment and encryption flows

## Key Test Scenarios

### Security Tests
1. **Encryption Integrity**: Tamper detection, key validation
2. **Access Control**: Permission verification, expired access
3. **Authentication**: Token validation, session management

### Business Logic Tests
1. **Payment Flow**: Stripe integration, blockchain conversion
2. **Content Access**: Purchase verification, key escrow
3. **Auto-Decryption**: Seamless user experience

### Error Handling Tests
1. **Database Failures**: Connection errors, constraint violations
2. **External API Failures**: Stripe errors, blockchain issues
3. **Input Validation**: Malformed data, edge cases

### Performance Tests
1. **Encryption Performance**: Large content handling
2. **Concurrent Operations**: Multiple user sessions
3. **Database Operations**: Query optimization

## Continuous Integration

The test suite is designed for CI/CD integration:

```yaml
# Example GitHub Actions workflow
- name: Run Tests
  run: |
    cd backend
    npm ci
    npm run test:coverage
    npm run lint
    npm run typecheck
```

## Test Data Management

Tests use:
- **Deterministic Test Data**: Consistent UUIDs and timestamps
- **Isolated Test Environment**: No shared state between tests
- **Mocked External Dependencies**: No real API calls or database connections
- **Cleanup Procedures**: Automatic test data cleanup

## Debugging Tests

### Common Issues
1. **Mock Setup**: Ensure all external dependencies are properly mocked
2. **Async Operations**: Use proper async/await patterns
3. **Environment Variables**: Check test environment configuration
4. **Type Safety**: Verify TypeScript types in test files

### Debug Commands
```bash
# Run single test with verbose output
npm test -- --reporter=verbose encryption.service.test.ts

# Debug with Node.js inspector
npm run test:debug

# Generate coverage report
npm run test:coverage
```

## Adding New Tests

When adding new features, ensure:

1. **Unit Tests** for each service/function
2. **Integration Tests** for new API endpoints
3. **Error Handling** for all failure scenarios
4. **Performance Tests** for computationally intensive operations
5. **Security Tests** for authentication/authorization changes

### Test Template
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('New Feature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should handle happy path', async () => {
    // Arrange
    // Act  
    // Assert
  });

  it('should handle error cases', async () => {
    // Test error scenarios
  });
});
```

## Test Quality Standards

- **Clear Test Names**: Descriptive test descriptions
- **Isolated Tests**: No dependencies between tests
- **Comprehensive Coverage**: All code paths tested
- **Performance Aware**: Tests complete in reasonable time
- **Maintainable**: Easy to update when features change

This comprehensive test suite ensures the OpenContext PoC is **production-ready** and **investor-demonstration worthy**.