import { FareService } from '../../../app/modules/fare/fare.service';
import prisma from '../../../app/config/prisma';
import { DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

jest.mock('../../../app/config/prisma');

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

const { id, createdAt, updatedAt, ...createPayload } = fareFixture;

describe('FareService', () => {
  describe('createFare', () => {
    it('creates a fare config when country does not exist', async () => {
      prismaMock.fare.findUnique.mockResolvedValue(null);
      prismaMock.fare.create.mockResolvedValue(fareFixture);

      const result = await FareService.createFare(createPayload);

      expect(prismaMock.fare.findUnique).toHaveBeenCalledWith({ where: { country: 'BD' } });
      expect(prismaMock.fare.create).toHaveBeenCalledTimes(1);
      expect(result.country).toBe('BD');
    });

    it('uppercases the country code before saving', async () => {
      prismaMock.fare.findUnique.mockResolvedValue(null);
      prismaMock.fare.create.mockResolvedValue({ ...fareFixture, country: 'US' });

      await FareService.createFare({ ...createPayload, country: 'us' });

      expect(prismaMock.fare.findUnique).toHaveBeenCalledWith({ where: { country: 'US' } });
      expect(prismaMock.fare.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ country: 'US' }) }),
      );
    });

    it('throws 400 when a fare config already exists for the country', async () => {
      prismaMock.fare.findUnique.mockResolvedValue(fareFixture);

      await expect(FareService.createFare(createPayload)).rejects.toMatchObject({
        statusCode: 400,
        message: 'Fare configuration already exists for this country',
      });

      expect(prismaMock.fare.create).not.toHaveBeenCalled();
    });
  });

  describe('getFareByCountry', () => {
    it('returns the fare config for a given country', async () => {
      prismaMock.fare.findUnique.mockResolvedValue(fareFixture);

      const result = await FareService.getFareByCountry('BD');

      expect(prismaMock.fare.findUnique).toHaveBeenCalledWith({ where: { country: 'BD' } });
      expect(result.country).toBe('BD');
    });

    it('throws 404 when country fare config is not found', async () => {
      prismaMock.fare.findUnique.mockResolvedValue(null);

      await expect(FareService.getFareByCountry('XX')).rejects.toMatchObject({
        statusCode: 404,
        message: 'Fare configuration not found',
      });
    });
  });

  describe('deleteFare', () => {
    it('hard-deletes a fare config', async () => {
      prismaMock.fare.findUnique.mockResolvedValue(fareFixture);
      prismaMock.fare.delete.mockResolvedValue(fareFixture);

      const result = await FareService.deleteFare('fare-uuid-1');

      expect(prismaMock.fare.delete).toHaveBeenCalledWith({
        where: { id: 'fare-uuid-1' },
      });
      expect(result.id).toBe('fare-uuid-1');
    });

    it('throws 404 when fare config to delete is not found', async () => {
      prismaMock.fare.findUnique.mockResolvedValue(null);

      await expect(FareService.deleteFare('non-existent-id')).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });
});
