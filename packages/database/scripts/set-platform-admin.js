// One-off utility: grants isPlatformAdmin to a user by email. Run via `railway run` so DATABASE_URL
// points at the real environment. Usage: node scripts/set-platform-admin.js <email>
const { PrismaClient } = require("@prisma/client");

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error("Usage: node scripts/set-platform-admin.js <email>");
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.update({ where: { email }, data: { isPlatformAdmin: true } });
    console.log(`isPlatformAdmin=true set for ${user.email} (id ${user.id})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
