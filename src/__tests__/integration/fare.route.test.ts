import request from 'supertest';
import app from '../../app';
import prisma from '../../app/config/prisma';
import { DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

jest.mock('../../app/config/prisma');

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

const fareFixture = {
  id: 'fare-uuid-1',
  country: 'BD',
  minoGoRatePerKm: 1.5,
  minoGoBookingFee: 2.0,
  minoGoBaseFee: 3.0,
  minoGoMinimumFare: 5.0,
  minoXLRatePerKm: 2.0,
  minoXLBookingFee: 2.5,
  minoXLBaseFee: 4.0,
  minoXLMinimumFare: 7.0,
  minoMotoRatePerKm: 0.8,
  minoMotoBookingFee: 1.0,
  minoMotoBaseFee: 1.5,
  minoMotoMinimumFare: 3.0,
  waitingChargeEnabled: true,
  waitingChargeGracePeriod: 3,
  waitingChargeRate: 0.5,
  surchargeEnabled: false,
  surchargeValue: 0,
  governmentTaxEnabled: false,
  governmentTaxPercentage: 0,
  platformCommissionPercentage: 20,
  isActive: true,
  isDeleted: false,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

describe('POST /api/v1/fare/create', () => {
  const { id, createdAt, updatedAt, ...createBody } = fareFixture;

  it('returns 201 and the new fare config', async () => {
    prismaMock.fare.findUnique.mockResolvedValue(null);
    prismaMock.fare.create.mockResolvedValue(fareFixture);

    const res = await request(app)
      .post('/api/v1/fare/create')
      .send(createBody);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.country).toBe('BD');
  });

  it('returns 400 when fare config already exists', async () => {
    prismaMock.fare.findUnique.mockResolvedValue(fareFixture);

    const res = await request(app)
      .post('/api/v1/fare/create')
      .send(createBody);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/v1/fare/:country', () => {
  it('returns 200 with fare config for the country', async () => {
    prismaMock.fare.findUnique.mockResolvedValue(fareFixture);

    const res = await request(app).get('/api/v1/fare/BD');

    expect(res.status).toBe(200);
    expect(res.body.data.country).toBe('BD');
  });

  it('returns 404 when country fare config does not exist', async () => {
    prismaMock.fare.findUnique.mockResolvedValue(null);

    const res = await request(app).get('/api/v1/fare/XX');

    expect(res.status).toBe(404);
  });
});
