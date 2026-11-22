import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import mongoose from 'mongoose';
import {
  generateAccountId,
  generateUserCode,
  hashSecret,
} from '../auth/identity.util';
import { Tenant, TenantSchema } from '../auth/schemas/tenant.schema';
import { User, UserSchema } from '../auth/schemas/user.schema';

function parseEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cleaned = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).trim()
      : trimmed;
    const idx = cleaned.indexOf('=');
    if (idx <= 0) continue;
    const key = cleaned.slice(0, idx).trim();
    let val = cleaned.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1).trim();
    }
    if (!process.env[key] && val) {
      process.env[key] = val;
    }
  }
}

function loadEnv() {
  parseEnvFile(path.resolve(process.cwd(), '.env.local'));
  parseEnvFile(path.resolve(process.cwd(), '.env'));
}

async function run() {
  loadEnv();

  const email = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD;
  const name = process.env.SUPER_ADMIN_NAME?.trim() || 'Leadsetu HQ Authority';

  if (!email || !password || password.length < 10) {
    console.error(
      'Usage: Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD (>= 10 chars) in env or command before running.',
    );
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    console.error(
      'MONGODB_URI environment variable is required. Set it in .env or environment before running.',
    );
    process.exit(1);
  }

  await mongoose.connect(uri);

  const TenantModel = mongoose.model(Tenant.name, TenantSchema);
  const UserModel = mongoose.model(User.name, UserSchema);

  let hq = await TenantModel.findOne({
    $or: [{ isPlatformHq: true }, { slug: 'leadsetu-platform-hq' }],
  }).exec();

  if (!hq) {
    hq = await TenantModel.create({
      name: 'Leadsetu Platform HQ',
      slug: 'leadsetu-platform-hq',
      accountId: await generateAccountId(TenantModel),
      plan: 'enterprise',
      status: 'active',
      isPlatformHq: true,
      city: 'Noida & New Delhi',
      state: 'Delhi (07)',
      gstin: '07AABCL4821K1Z5',
      email: 'hq@leadsetu.in',
    });
  }

  const existing = await UserModel.findOne({ email }).exec();
  if (existing) {
    existing.role = 'super_admin';
    existing.departmentPreset = 'hq';
    existing.permissions = ['*'];
    existing.isActive = true;
    existing.passwordHash = hashSecret(password);
    existing.tenantId = hq._id;
    await existing.save();
    console.log(`Updated existing account to Super Admin Authority: ${email}`);
  } else {
    await UserModel.create({
      tenantId: hq._id,
      userCode: await generateUserCode(UserModel),
      name,
      email,
      passwordHash: hashSecret(password),
      role: 'super_admin',
      departmentPreset: 'hq',
      permissions: ['*'],
      isActive: true,
      territory: 'Leadsetu Platform HQ',
    });
    console.log(`Created new Super Admin Authority account: ${email}`);
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Failed to bootstrap Super Admin:', err);
  process.exit(1);
});
