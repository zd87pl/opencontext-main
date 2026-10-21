/**
 * Builds a `req.user` for tests. Routes only read `id`, `name` and `email`;
 * the remaining Prisma columns (Decimal balances, timestamps) are not needed,
 * so this is a partial object typed as the full user.
 */
export function fakeUser(overrides: Partial<Express.User> = {}): Express.User {
  return {
    id: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    avatar: null,
    emailVerified: true,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides
  } as Express.User;
}
