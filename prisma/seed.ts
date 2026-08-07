import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { PROVIDER_RATE_CARD } from '../src/config/provider-rate-card/index.js';
import { createPrismaProviderRateCardAdminRepository } from '../src/repositories/provider-rate-card-admin.repository.js';
import {
  createDefaultProviderRateCardAdminDependencies,
  importStaticRateCardAsDraft,
  validateRateCardDraft,
  publishRateCard,
} from '../src/services/admin-rate-card.service.js';

const prisma = new PrismaClient();

interface BadgeSeed {
  name: string;
  description: string;
  criteriaType: string;
  criteriaValue: number | null;
  iconUrl: string;
}

interface StepSeed {
  stepNumber: number;
  title: string;
  content: string;
  xpReward: number;
}

interface JourneySeed {
  slug: string;
  title: string;
  description: string;
  xpReward: number;
  steps: StepSeed[];
}

const BADGES: BadgeSeed[] = [
  { name: 'Welcome Aboard', description: 'Awarded at registration', criteriaType: 'manual', criteriaValue: null, iconUrl: '🎉' },
  { name: 'Verified', description: 'Awarded on email verification', criteriaType: 'manual', criteriaValue: null, iconUrl: '✅' },
  { name: 'Getting Started', description: 'Reach 100 XP', criteriaType: 'xp_threshold', criteriaValue: 100, iconUrl: '🌱' },
  { name: 'Power User', description: 'Reach 1000 XP', criteriaType: 'xp_threshold', criteriaValue: 1000, iconUrl: '⚡' },
  { name: 'Century Club', description: 'Send 100 messages', criteriaType: 'action_count', criteriaValue: 100, iconUrl: '💬' },
  // Quest completion badges (journey_complete — awarded by journey.service config map)
  { name: 'Scam-Smart Traveler', description: 'Complete the Scam-Smart Traveler journey', criteriaType: 'journey_complete', criteriaValue: null, iconUrl: '🕵️' },
  { name: 'Taxi Savvy', description: 'Complete the Taxi Tricks & Meter Games journey', criteriaType: 'journey_complete', criteriaValue: null, iconUrl: '🚕' },
  { name: 'Money Maestro', description: 'Complete the Street Money Exchange journey', criteriaType: 'journey_complete', criteriaValue: null, iconUrl: '💱' },
  { name: 'Guide Guardian', description: 'Complete the Fake Guides & Papyrus Shops journey', criteriaType: 'journey_complete', criteriaValue: null, iconUrl: '🧭' },
  { name: 'Card Safe', description: 'Complete the ATM & Card Traps journey', criteriaType: 'journey_complete', criteriaValue: null, iconUrl: '💳' },
  { name: 'Pyramid Pioneer', description: 'Complete the Giza Plateau journey', criteriaType: 'journey_complete', criteriaValue: null, iconUrl: '🔺' },
  { name: 'Temple Walker', description: 'Complete the Karnak & Luxor journey', criteriaType: 'journey_complete', criteriaValue: null, iconUrl: '🛕' },
  { name: 'Nubia Navigator', description: 'Complete the Abu Simbel & Nubia journey', criteriaType: 'journey_complete', criteriaValue: null, iconUrl: '🏛️' },
  { name: 'Old Cairo Explorer', description: 'Complete the Coptic & Islamic Cairo journey', criteriaType: 'journey_complete', criteriaValue: null, iconUrl: '🕌' },
  // Theme badges (awarded when every quest in a theme is completed)
  { name: 'Scam Shield', description: 'Complete every scam-safety quest', criteriaType: 'journey_complete', criteriaValue: null, iconUrl: '🛡️' },
  { name: 'Antiquity Explorer', description: 'Complete every archaeology quest', criteriaType: 'journey_complete', criteriaValue: null, iconUrl: '🗿' },
];

const JOURNEYS: JourneySeed[] = [
  {
    slug: 'scam-smart-traveler',
    title: 'Scam-Smart Traveler',
    description: 'Learn practical ways to recognize and avoid common travel scams in Egypt.',
    xpReward: 50,
    steps: [
      { stepNumber: 1, title: 'Confirm the price and currency', content: 'Agree on the total price and currency before accepting a ride, service, or tour.', xpReward: 10 },
      { stepNumber: 2, title: 'Use official channels', content: 'Prefer official entrances, licensed guides, and app-based transport when available.', xpReward: 10 },
      { stepNumber: 3, title: 'Protect your documents and payment cards', content: 'Keep passports, cards, and PINs private; use secure payment methods.', xpReward: 10 },
      { stepNumber: 4, title: 'Pause when pressured', content: 'Walk away from unexpected urgency, free gifts, or requests to change the agreed deal.', xpReward: 10 },
      { stepNumber: 5, title: 'Know how to report a problem', content: 'Keep receipts and contact the official venue, accommodation, or local emergency service when needed.', xpReward: 10 },
    ],
  },
  {
    slug: 'taxi-tricks',
    title: 'Taxi Tricks & Meter Games',
    description: 'Stay ahead of the classic taxi and driver scams in Cairo and the resorts.',
    xpReward: 50,
    steps: [
      { stepNumber: 1, title: 'Agree on the fare before you get in', content: 'Before the ride starts, agree on the total price in Egyptian pounds (EGP) or insist the meter runs. Confirming the fare up front removes most surprises.', xpReward: 10 },
      { stepNumber: 2, title: 'Prefer app-based or hotel rides', content: 'Licensed ride apps give transparent prices and route tracking. If you use a street taxi, book it through your hotel when possible.', xpReward: 10 },
      { stepNumber: 3, title: 'Beware the broken meter trick', content: 'Some drivers claim the meter is broken and name a price two to three times higher at the end. If the meter is "broken", agree on the fixed fare before starting.', xpReward: 10 },
      { stepNumber: 4, title: 'Know the route and keep small notes', content: 'Follow the route on your phone map and decline surprise detours to "special" shops or "a friend\'s museum". Carry small change so paying the agreed fare is easy.', xpReward: 10 },
    ],
  },
  {
    slug: 'street-money-exchange',
    title: 'Street Money Exchange',
    description: 'Avoid the classic cash-swap and short-change tricks around exchange counters.',
    xpReward: 50,
    steps: [
      { stepNumber: 1, title: 'Only use official exchange points', content: 'Change money at banks, licensed exchange offices, or your hotel — never on the street. Street rates may look better but come with real risk.', xpReward: 10 },
      { stepNumber: 2, title: 'Check the official rate first', content: 'Look up today\'s official rate on your phone before exchanging. A rate that is far better than the official one is almost always a scam.', xpReward: 10 },
      { stepNumber: 3, title: 'Watch the counting trick', content: 'Count every bill yourself before the exchange is final. A common trick is short-changing by a note or two while distracting you.', xpReward: 10 },
      { stepNumber: 4, title: 'Never hand your money first', content: 'The classic flip: you hand over your cash and it is swapped with a smaller folded stack. Keep your money in your hand until the deal is complete and counted.', xpReward: 10 },
    ],
  },
  {
    slug: 'fake-guide-papyrus',
    title: 'Fake Guides & Papyrus Shops',
    description: 'Spot unlicensed guides and the high-pressure souvenir shop game near monuments.',
    xpReward: 50,
    steps: [
      { stepNumber: 1, title: 'Check for an official license', content: 'Official guides carry a licensed badge or ID from the Ministry of Tourism. Guides who approach you uninvited near sites are usually selling commissions.', xpReward: 10 },
      { stepNumber: 2, title: 'Book through official channels', content: 'Book tours through your hotel, licensed operators, or the official site ticket office rather than an informal offer on the street.', xpReward: 10 },
      { stepNumber: 3, title: 'Beware the high-pressure shop', content: 'A shop that blocks the exit, insists you "look at this special papyrus", or pressures you to buy before you leave is a classic trap. Politely decline and walk out.', xpReward: 10 },
      { stepNumber: 4, title: 'Know the commission game', content: 'If your driver or "guide" takes you to a shop, assume prices are inflated to cover their commission. Buy elsewhere for honest prices.', xpReward: 10 },
    ],
  },
  {
    slug: 'atm-card-scam',
    title: 'ATM & Card Traps',
    description: 'Keep your cards and PIN safe from skimmers, shoulder surfers, and card swaps.',
    xpReward: 50,
    steps: [
      { stepNumber: 1, title: 'Prefer bank ATMs indoors', content: 'Use ATMs inside banks or hotels rather than isolated street machines, which are easier to tamper with or observe.', xpReward: 10 },
      { stepNumber: 2, title: 'Check for skimmers and cover your PIN', content: 'Wiggle the card slot, look for loose readers, and cover your PIN with your other hand while typing.', xpReward: 10 },
      { stepNumber: 3, title: 'Never let the card leave your sight', content: 'Handing your card to a merchant or "helper" gives them a moment to clone it. Pay at the terminal yourself and keep the card visible.', xpReward: 10 },
      { stepNumber: 4, title: 'Freeze and report immediately', content: 'If your card is lost, swallowed, or misused, freeze it in your banking app right away and call your bank. Notify the venue and your accommodation too.', xpReward: 10 },
    ],
  },
  {
    slug: 'giza-plateau',
    title: 'The Giza Plateau',
    description: 'Walk the home of the Great Pyramid and the Sphinx with a fresh eye for detail.',
    xpReward: 50,
    steps: [
      { stepNumber: 1, title: 'Three kings, one plateau', content: 'The Great Pyramid (Khufu), Khafre, and Menkaure were raised over about 80 years in the Old Kingdom (c. 2550–2490 BC). The Sphinx guards Khafre\'s causeway.', xpReward: 10 },
      { stepNumber: 2, title: 'See it from the panorama point', content: 'The best view is from the western panorama ridge. Stay on marked paths — climbing the pyramids is forbidden and dangerous.', xpReward: 10 },
      { stepNumber: 3, title: 'Inside the Great Pyramid', content: 'Limited tickets are released twice a day. The Grand Gallery and King\'s Chamber are memorable, but it is hot and steep — go early and take water.', xpReward: 10 },
      { stepNumber: 4, title: 'Plan your visit', content: 'Buy tickets at the official gate, agree on camel or horse prices BEFORE riding, and allow three to four hours. Sunset and the Sound & Light show are highlights.', xpReward: 10 },
    ],
  },
  {
    slug: 'karnak-luxor',
    title: 'Karnak & Luxor Temples',
    description: 'Thebes at its most majestic — colossal columns, obelisks, and a city of temples.',
    xpReward: 50,
    steps: [
      { stepNumber: 1, title: 'Karnak\'s Great Hypostyle Hall', content: 'A forest of 134 towering columns — many over 20 metres high — built by Seti I and Ramesses II. It is one of the largest religious buildings ever made.', xpReward: 10 },
      { stepNumber: 2, title: 'Obelisks and the sacred lake', content: 'Hatshepsut\'s single granite obelisk and the sacred lake reflect Thebes\' power. The Avenue of Sphinxes links Karnak to Luxor Temple across 2.7 km.', xpReward: 10 },
      { stepNumber: 3, title: 'Luxor Temple after dark', content: 'Ramesses II\'s pylon, the Abu Haggag mosque built inside the temple, and warm night lighting make an evening visit unforgettable.', xpReward: 10 },
      { stepNumber: 4, title: 'Practical tips', content: 'Go early to beat the heat and crowds, hire a licensed guide at the entrance, and carry water. Combined tickets and Sound & Light shows are available.', xpReward: 10 },
    ],
  },
  {
    slug: 'abu-simbel-nubia',
    title: 'Abu Simbel & Nubia',
    description: 'The colossal rock temples of Ramesses II and the story of their famous rescue.',
    xpReward: 50,
    steps: [
      { stepNumber: 1, title: 'The great rock temples', content: 'Ramesses II carved four colossal statues of himself into the cliff at Abu Simbel (c. 1264 BC), alongside a smaller temple dedicated to Hathor and Queen Nefertari.', xpReward: 10 },
      { stepNumber: 2, title: 'The UNESCO rescue', content: 'In the 1960s the temples were cut into blocks and reassembled 65 metres higher to escape the rising waters of Lake Nasser — a legendary international rescue.', xpReward: 10 },
      { stepNumber: 3, title: 'The solar alignment', content: 'Twice a year, sunlight pierces the inner sanctum to light the statues of the gods — an alignment engineered thousands of years ago.', xpReward: 10 },
      { stepNumber: 4, title: 'Getting there', content: 'Reach Abu Simbel on the early convoy from Aswan or by a short flight. Combine it with Philae Temple near Aswan for a full Nubian day.', xpReward: 10 },
    ],
  },
  {
    slug: 'coptic-islamic-cairo',
    title: 'Coptic & Islamic Cairo',
    description: 'Two thousand years of Cairo\'s sacred history in a single walkable district.',
    xpReward: 50,
    steps: [
      { stepNumber: 1, title: 'Coptic Cairo', content: 'The Hanging Church (al-Muallaqa), the Church of St. Sergius, and the Ben Ezra Synagogue cluster on the site of the Roman fortress of Babylon.', xpReward: 10 },
      { stepNumber: 2, title: 'The Citadel of Saladin', content: 'Built in the 12th century, its Mosque of Muhammad Ali offers panoramic views over the city of a thousand minarets.', xpReward: 10 },
      { stepNumber: 3, title: 'Medieval streets & Khan el-Khalili', content: 'Walk al-Muizz street\'s Mamluk monuments and the famous Khan el-Khalili bazaar — bargain politely and keep a hand on your pockets.', xpReward: 10 },
      { stepNumber: 4, title: 'Walk the old city', content: 'Many mosques ask for modest dress and closed shoes. Go in the late afternoon for cooler air and golden light on the minarets.', xpReward: 10 },
    ],
  },
];

async function seedProviderRateCard(actorUserId: string): Promise<void> {
  const version = PROVIDER_RATE_CARD.version;
  const adminRepo = createPrismaProviderRateCardAdminRepository(prisma);
  const adminDeps = createDefaultProviderRateCardAdminDependencies(adminRepo);

  const existing = await adminDeps.repository.findSnapshotByVersion(version);
  if (existing !== null) {
    if (existing.status === 'ACTIVE') {
      const validation = await validateRateCardDraft(adminDeps, version);
      if (validation.valid) {
        console.log(`Provider Rate Card v${version} is already ACTIVE and valid (${existing.entries.length} entries).`);
        return;
      }
      throw new Error(`Provider Rate Card v${version} is ACTIVE but failed validation`);
    } else if (existing.status === 'DRAFT') {
      const validation = await validateRateCardDraft(adminDeps, version);
      if (!validation.valid) {
        throw new Error(`Provider Rate Card DRAFT v${version} failed validation`);
      }
      await publishRateCard(adminDeps, { version, effectiveFrom: '2026-08-03' }, actorUserId);
      console.log(`Published existing DRAFT Provider Rate Card v${version} as ACTIVE.`);
      return;
    } else {
      throw new Error(`Provider Rate Card v${version} exists in unexpected state: ${existing.status}`);
    }
  }

  await importStaticRateCardAsDraft(adminDeps, { version }, actorUserId);

  const validation = await validateRateCardDraft(adminDeps, version);
  if (!validation.valid) {
    throw new Error(`Provider Rate Card DRAFT v${version} failed validation`);
  }

  await publishRateCard(adminDeps, { version, effectiveFrom: '2026-08-03' }, actorUserId);
  console.log(`Seeded and published initial ACTIVE Provider Rate Card v${version} (${validation.entryCount} entries).`);
}

async function main() {
  const roles = [
    { name: 'user', permissions: [] },
    { name: 'moderator', permissions: ['users:read', 'content:moderate'] },
    { name: 'admin', permissions: ['users:read', 'users:write', 'users:ban', 'roles:assign'] },
  ];

  for (const role of roles) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: { permissions: role.permissions },
      create: role,
    });
  }

  for (const badge of BADGES) {
    await prisma.badge.upsert({
      where: { name: badge.name },
      update: {
        description: badge.description,
        criteriaType: badge.criteriaType,
        criteriaValue: badge.criteriaValue,
        iconUrl: badge.iconUrl,
      },
      create: badge,
    });
  }

  for (const journeySeed of JOURNEYS) {
    const journey = await prisma.journey.upsert({
      where: { slug: journeySeed.slug },
      update: {
        title: journeySeed.title,
        description: journeySeed.description,
        xpReward: journeySeed.xpReward,
        isActive: true,
      },
      create: {
        slug: journeySeed.slug,
        title: journeySeed.title,
        description: journeySeed.description,
        xpReward: journeySeed.xpReward,
        isActive: true,
      },
    });

    for (const step of journeySeed.steps) {
      await prisma.journeyStep.upsert({
        where: { journeyId_stepNumber: { journeyId: journey.id, stepNumber: step.stepNumber } },
        update: step,
        create: { ...step, journeyId: journey.id },
      });
    }
  }

  // مستخدم admin افتراضي للتطوير المحلي
  const adminRole = await prisma.role.findUnique({ where: { name: 'admin' } });
  if (!adminRole) {
    throw new Error('Admin role not found - make sure roles are seeded before the admin user');
  }

  const passwordHash = await bcrypt.hash('Admin1234!', 10);

  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      email: 'admin@example.com',
      passwordHash,
      displayName: 'Admin',
      gender: 'MALE',
      nationality: 'Egyptian',
      roleId: adminRole.id,
      isEmailVerified: true,
    },
  });

  console.log(
    `Seeded ${roles.length} roles, ${BADGES.length} badges, ${JOURNEYS.length} quests, and admin user (admin@example.com / Admin1234!)`,
  );

  // Seed Provider Rate Card
  await seedProviderRateCard(adminUser.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
