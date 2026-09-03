/**
 * Auth tests — login success/failure, /me endpoint, token edge cases.
 */
import './setup';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import app from '../app';
import { prisma } from '../lib/prisma';
import { Role } from '@prisma/client';

const TEST_EMAIL = `auth-test-${Date.now()}@test.com`;
const TEST_PASSWORD = 'TestPass123!';
let userId: string;

beforeAll(async () => {
  const hash = await bcrypt.hash(TEST_PASSWORD, 10);
  const user = await prisma.user.create({
    data: { name: 'Auth Test User', email: TEST_EMAIL, password: hash, role: Role.ADMIN },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } }).catch(() => null);
  await prisma.$disconnect();
});

// ── Login ─────────────────────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
  it('returns 200 + JWT + user object on valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(20);
    expect(res.body.user.email).toBe(TEST_EMAIL);
    expect(res.body.user.role).toBe('ADMIN');
    // password must never appear in the response
    expect(JSON.stringify(res.body)).not.toContain('hash');
    expect(res.body.user.password).toBeUndefined();
  });

  it('returns 401 on wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: 'WrongPassword!' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 401 on unknown email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@nowhere.com', password: TEST_PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 422 when email is missing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ password: TEST_PASSWORD });

    expect(res.status).toBe(422);
  });

  it('returns 422 when password is missing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL });

    expect(res.status).toBe(422);
  });

  it('returns 422 when email is not a valid email address', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'not-an-email', password: TEST_PASSWORD });

    expect(res.status).toBe(422);
  });

  it('returns 401 for an inactive user', async () => {
    const hash = await bcrypt.hash(TEST_PASSWORD, 10);
    const inactive = await prisma.user.create({
      data: {
        name: 'Inactive User',
        email: `inactive-${Date.now()}@test.com`,
        password: hash,
        role: Role.SALES,
        isActive: false,
      },
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: inactive.email, password: TEST_PASSWORD });

    expect(res.status).toBe(401);

    await prisma.user.delete({ where: { id: inactive.id } });
  });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────

describe('GET /api/auth/me', () => {
  let token: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    token = res.body.token as string;
  });

  it('returns 200 + user payload for a valid token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.email).toBe(TEST_EMAIL);
    expect(res.body.user.role).toBe('ADMIN');
  });

  it('returns 401 when Authorization header is absent', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 for a malformed token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer this.is.garbage');
    expect(res.status).toBe(401);
  });

  it('returns 401 when the Bearer prefix is missing', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', token); // no "Bearer " prefix
    expect(res.status).toBe(401);
  });
});
