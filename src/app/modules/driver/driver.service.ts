
import prisma from '../../config/prisma';

const toggleOnlineStatus = async (
  driverProfileId: string,
  isOnline: boolean,
  lat?: number,
  lng?: number,
) => {
  const driver = await prisma.driverProfile.findUnique({ where: { id: driverProfileId } });
  if (!driver) throw new Error('Driver profile not found');

  if (driver.approvalStatus !== 'verified') {
    throw new Error('Only verified drivers can go online');
  }

  if (isOnline && (!lat || !lng || isNaN(lat) || isNaN(lng))) {
    throw new Error('lat and lng are required when going online');
  }

  return prisma.driverProfile.update({
    where: { id: driverProfileId },
    data:  isOnline
      ? { isOnline: true, currentLat: lat, currentLng: lng }
      : { isOnline: false },
    select: { isOnline: true, currentLat: true, currentLng: true, vehicleTypes: true, approvalStatus: true },
  });
};

// ─────────────────────────────────────────────────────────────────────────────

const getEarnings = async (
  driverProfileId: string,
  options: { from: string; to: string },
) => {
  const driver = await prisma.driverProfile.findUnique({ where: { id: driverProfileId } });
  if (!driver) throw new Error('Driver profile not found');

  const from = new Date(options.from);
  from.setHours(0, 0, 0, 0);
  const to = new Date(options.to);
  to.setHours(23, 59, 59, 999);

  const rides = await prisma.ride.findMany({
    where: {
      driverId:  driverProfileId,
      status:    'COMPLETED',
      createdAt: { gte: from, lte: to },
      isDeleted: false
    },
    select: {
      pickupAddress:  true,
      dropoffAddress: true,
      driverEarning:  true,
      durationMin:    true,
      createdAt:      true,
    },
    orderBy: { createdAt: 'desc' },
  });

  const totalEarned         = rides.reduce((s, r) => s + (r.driverEarning ?? 0), 0);
  const totalCompletedTrips = rides.length;

  const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const breakdownMap: Record<string, number> = {};

  rides.forEach((r) => {
    const label = DAY_LABELS[(new Date(r.createdAt).getDay() + 6) % 7];
    breakdownMap[label] = (breakdownMap[label] ?? 0) + (r.driverEarning ?? 0);
  });

  const breakdown = DAY_LABELS.map((label) => ({
    label,
    amount: breakdownMap[label] ?? 0,
  }));

  const fmt        = (d: Date) => d.toLocaleString('en', { month: 'short', day: 'numeric' });
  const rangeLabel = `${fmt(from)} - ${fmt(to)}`;

  return { rangeLabel, from: from.toISOString(), to: to.toISOString(), totalEarned, totalCompletedTrips, breakdown };
};

// ─────────────────────────────────────────────────────────────────────────────

const getDriverStats = async (driverProfileId: string) => {
  const driver = await prisma.driverProfile.findUnique({ where: { id: driverProfileId } });
  if (!driver) throw new Error('Driver profile not found');

  const agg = await prisma.ride.aggregate({
    where: { driverId: driverProfileId, status: 'COMPLETED' },
    _sum:  { tip: true, durationMin: true },
  });

  const totalEarningFromTip = agg._sum.tip        ?? 0;
  const activeTimeMinutes   = agg._sum.durationMin ?? 0;

  const activeHours   = Math.floor(activeTimeMinutes / 60);
  const activeMinutes = activeTimeMinutes % 60;
  const activeTime    = activeHours > 0
    ? `${activeHours}h ${activeMinutes}m`
    : `${activeMinutes}m`;

  const recentTrips = await prisma.ride.findMany({
    where:   { driverId: driverProfileId, status: 'COMPLETED', isDeleted: false },
    orderBy: { createdAt: 'desc' },
    take:    10,
    select:  {
      pickupAddress:  true,
      dropoffAddress: true,
      driverEarning:  true,
      tip:            true,
      durationMin:    true,
      createdAt:      true,
    },
  });

  const recentCompletedTrips = recentTrips.map((r) => ({
    pickup:      r.pickupAddress  ?? '',
    dropoff:     r.dropoffAddress ?? '',
    date:        r.createdAt,
    amount:      r.driverEarning  ?? 0,
    tip:         r.tip            ?? 0,
    durationMin: r.durationMin    ?? 0,
  }));

  return {
    totalTrips:           driver.totalTrips     ?? 0,
    totalEarning:         driver.totalEarnings  ?? 0,
    walletBalance:        driver.walletBalance  ?? 0,
    averageRating:        driver.averageRating  ?? 0,
    totalEarningFromTip,
    activeTime,
    activeTimeMinutes,
    recentCompletedTrips,
  };
};

// ─────────────────────────────────────────────────────────────────────────────

export const DriverService = {
  toggleOnlineStatus,
  getEarnings,
  getDriverStats,
};
