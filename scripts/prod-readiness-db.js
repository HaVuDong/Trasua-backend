#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const backendRoot = path.resolve(__dirname, '..');
const command = process.argv[2] || 'audit';
const flags = new Set(process.argv.slice(3));

const OPEN_PRINT_STATUSES = ['REQUESTED', 'PRINTING'];
const OLD_PRINT_JOB_KEY = { tenantId: 1, invoiceId: 1, type: 1, status: 1 };
const NEW_PRINT_JOB_KEY = { tenantId: 1, invoiceId: 1, type: 1 };
const NEW_PRINT_JOB_INDEX_NAME = 'uniq_open_print_job_per_invoice_type';

const moneyAudits = [
  {
    collection: 'inventoryitems',
    paths: ['costPrice', 'sellingPrice'],
  },
  {
    collection: 'importtickets',
    paths: ['items.costPrice'],
  },
  {
    collection: 'menuitems',
    paths: ['sellingPrice'],
  },
  {
    collection: 'tenants',
    paths: ['subscription.amount', 'paymentHistory.amount'],
  },
  {
    collection: 'payrolls',
    paths: [
      'baseSalary',
      'overtimePay',
      'weekendPay',
      'holidayPay',
      'totalAllowances',
      'totalDeductions',
      'totalPayout',
      'finalSalary',
      'allowances.amount',
      'deductions.amount',
    ],
  },
  {
    collection: 'customerpayments',
    paths: ['amount'],
  },
  {
    collection: 'saaspayments',
    paths: ['amount'],
  },
  {
    collection: 'invoices',
    paths: [
      'subtotal',
      'discount',
      'vat',
      'serviceCharge',
      'finalAmount',
      'itemSnapshot.unitPrice',
      'itemSnapshot.lineTotal',
    ],
  },
  {
    collection: 'cashmovements',
    paths: ['amount'],
  },
];

const quantityAudits = [
  {
    collection: 'inventoryitems',
    paths: ['stock', 'minStockLevel'],
  },
  {
    collection: 'menuitemrecipes',
    paths: ['ingredients.requiredQuantity', 'ingredients.wastePercent'],
  },
  {
    collection: 'orders',
    paths: [
      'items.quantity',
      'items.recipeSnapshot.requiredQuantityPerUnit',
      'items.recipeSnapshot.totalRequiredQuantity',
      'items.costSnapshot.ingredients.requiredQuantity',
    ],
  },
];

function loadDotEnv() {
  const envPath = path.join(backendRoot, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function redactMongoUri(uri) {
  try {
    const parsed = new URL(uri);
    if (parsed.password) parsed.password = '***';
    if (parsed.username) parsed.username = '***';
    return parsed.toString();
  } catch {
    return '<configured>';
  }
}

function usage() {
  console.log(`Production readiness DB tools

Usage:
  node scripts/prod-readiness-db.js audit [--max-docs=50000]
  node scripts/prod-readiness-db.js migrate-indexes [--apply --backup-confirmed]

Notes:
  audit is read-only.
  migrate-indexes without --apply is dry-run.
  migrate-indexes with --apply requires --backup-confirmed.
`);
}

function readNumberFlag(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix));
  if (!raw) return fallback;
  const value = Number(raw.slice(prefix.length));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sameKey(left, right) {
  return JSON.stringify(left || {}) === JSON.stringify(right || {});
}

function isOpenPrintPartial(partial) {
  const statuses = partial?.status?.$in;
  return (
    Array.isArray(statuses) &&
    OPEN_PRINT_STATUSES.every((status) => statuses.includes(status))
  );
}

function getValuesByPath(value, parts) {
  if (value === undefined || value === null) return [];
  if (parts.length === 0) return [value];
  if (Array.isArray(value)) {
    return value.flatMap((item) => getValuesByPath(item, parts));
  }
  if (typeof value !== 'object') return [];
  const [head, ...tail] = parts;
  return getValuesByPath(value[head], tail);
}

function isInvalidIntegerNumber(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'number') {
    return !Number.isFinite(value) || !Number.isInteger(value);
  }
  if (typeof value === 'object' && value?._bsontype === 'Decimal128') {
    const asNumber = Number(value.toString());
    return !Number.isFinite(asNumber) || !Number.isInteger(asNumber);
  }
  return true;
}

function isDecimalNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && !Number.isInteger(value);
  }
  if (typeof value === 'object' && value?._bsontype === 'Decimal128') {
    const asNumber = Number(value.toString());
    return Number.isFinite(asNumber) && !Number.isInteger(asNumber);
  }
  return false;
}

function toDisplayValue(value) {
  if (typeof value === 'object' && value?._bsontype === 'Decimal128') {
    return value.toString();
  }
  return value;
}

async function collectionExists(db, name) {
  const collections = await db
    .listCollections({ name }, { nameOnly: true })
    .toArray();
  return collections.length > 0;
}

async function getCollection(db, name) {
  if (!(await collectionExists(db, name))) return null;
  return db.collection(name);
}

function statusLine(status, label, detail = '') {
  return { status, label, detail };
}

function printReport(title, rows) {
  console.log(`\n${title}`);
  for (const row of rows) {
    const detail = row.detail ? ` - ${row.detail}` : '';
    console.log(`[${row.status}] ${row.label}${detail}`);
  }
}

async function auditPrintJobIndexes(db) {
  const collection = await getCollection(db, 'printjobs');
  if (!collection) {
    return [statusLine('WARN', 'printjobs collection missing')];
  }

  const indexes = await collection.indexes();
  const oldIndexes = indexes.filter((index) =>
    sameKey(index.key, OLD_PRINT_JOB_KEY),
  );
  const newIndexes = indexes.filter(
    (index) =>
      sameKey(index.key, NEW_PRINT_JOB_KEY) &&
      index.unique === true &&
      isOpenPrintPartial(index.partialFilterExpression),
  );

  return [
    oldIndexes.length
      ? statusLine(
          'WARN',
          'old print job unique index still exists',
          oldIndexes.map((index) => index.name).join(', '),
        )
      : statusLine('PASS', 'old print job unique index absent'),
    newIndexes.length
      ? statusLine(
          'PASS',
          'new print job open-job unique index exists',
          newIndexes.map((index) => index.name).join(', '),
        )
      : statusLine('FAIL', 'new print job open-job unique index missing'),
  ];
}

async function auditDuplicateOpenPrintJobs(db) {
  const collection = await getCollection(db, 'printjobs');
  if (!collection) {
    return [statusLine('WARN', 'print job duplicate audit skipped')];
  }

  const duplicates = await collection
    .aggregate([
      { $match: { status: { $in: OPEN_PRINT_STATUSES } } },
      {
        $group: {
          _id: {
            tenantId: '$tenantId',
            invoiceId: '$invoiceId',
            type: '$type',
          },
          count: { $sum: 1 },
          ids: { $push: '$_id' },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 10 },
    ])
    .toArray();

  if (duplicates.length === 0) {
    return [statusLine('PASS', 'no duplicate open print jobs')];
  }

  return [
    statusLine(
      'FAIL',
      'duplicate open print jobs found',
      duplicates
        .map((row) => `${row._id.invoiceId}/${row._id.type}: ${row.count}`)
        .join('; '),
    ),
  ];
}

async function auditIntegerPaths(db, audits, maxDocs, label, invalidPredicate) {
  const rows = [];
  for (const audit of audits) {
    const collection = await getCollection(db, audit.collection);
    if (!collection) {
      rows.push(statusLine('WARN', `${label}: ${audit.collection} missing`));
      continue;
    }

    let scanned = 0;
    const issues = [];
    const cursor = collection.find({}, { limit: maxDocs });
    for await (const doc of cursor) {
      scanned += 1;
      for (const fieldPath of audit.paths) {
        const values = getValuesByPath(doc, fieldPath.split('.'));
        for (const value of values) {
          if (invalidPredicate(value)) {
            issues.push({
              id: doc._id?.toString?.() || String(doc._id),
              fieldPath,
              value: toDisplayValue(value),
            });
            break;
          }
        }
        if (issues.length >= 10) break;
      }
      if (issues.length >= 10) break;
    }

    const suffix =
      scanned >= maxDocs
        ? `scanned first ${maxDocs} docs; increase --max-docs for full audit`
        : `scanned ${scanned} docs`;
    if (issues.length === 0) {
      rows.push(statusLine('PASS', `${label}: ${audit.collection}`, suffix));
    } else {
      rows.push(
        statusLine(
          'WARN',
          `${label}: ${audit.collection} has ${issues.length}+ issue(s)`,
          `${suffix}; samples=${JSON.stringify(issues)}`,
        ),
      );
    }
  }
  return rows;
}

async function auditOldOrderCostSnapshots(db) {
  const collection = await getCollection(db, 'orders');
  if (!collection) {
    return [statusLine('WARN', 'orders collection missing')];
  }

  const rows = await collection
    .aggregate([
      { $match: { status: 'COMPLETED' } },
      { $unwind: '$items' },
      { $match: { 'items.status': { $ne: 'CANCELLED' } } },
      {
        $match: {
          $or: [
            { 'items.costSnapshot': { $exists: false } },
            { 'items.costSnapshot': null },
          ],
        },
      },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          orderIds: { $addToSet: '$_id' },
        },
      },
      {
        $project: {
          count: 1,
          orderIds: { $slice: ['$orderIds', 10] },
        },
      },
    ])
    .toArray();

  if (rows.length === 0) {
    return [statusLine('PASS', 'completed order items have cost snapshots')];
  }

  return [
    statusLine(
      'WARN',
      'completed order items missing costSnapshot',
      `count=${rows[0].count}; sampleOrderIds=${rows[0].orderIds.join(', ')}`,
    ),
  ];
}

async function auditSessionPaymentShape(db) {
  const collection = await getCollection(db, 'tablesessions');
  if (!collection) {
    return [statusLine('WARN', 'table session audit skipped')];
  }

  const missingPaymentStatus = await collection.countDocuments({
    paymentStatus: { $exists: false },
  });
  const missingStatus = await collection.countDocuments({
    status: { $exists: false },
  });

  const rows = [];
  rows.push(
    missingStatus === 0
      ? statusLine('PASS', 'table sessions have status')
      : statusLine(
          'WARN',
          'table sessions missing status',
          String(missingStatus),
        ),
  );
  rows.push(
    missingPaymentStatus === 0
      ? statusLine('PASS', 'table sessions have paymentStatus')
      : statusLine(
          'WARN',
          'table sessions missing paymentStatus',
          String(missingPaymentStatus),
        ),
  );
  return rows;
}

async function auditProductionReadiness(db) {
  const maxDocs = readNumberFlag('max-docs', 50000);
  const sections = [
    ['Print job indexes', await auditPrintJobIndexes(db)],
    ['Print job duplicate data', await auditDuplicateOpenPrintJobs(db)],
    [
      'Money integer VND audit',
      await auditIntegerPaths(
        db,
        moneyAudits,
        maxDocs,
        'money',
        isInvalidIntegerNumber,
      ),
    ],
    ['Old order cost snapshots', await auditOldOrderCostSnapshots(db)],
    ['Table session shape', await auditSessionPaymentShape(db)],
    [
      'Quantity decimal audit',
      await auditIntegerPaths(
        db,
        quantityAudits,
        maxDocs,
        'quantity decimal',
        isDecimalNumber,
      ),
    ],
  ];

  const allRows = sections.flatMap(([, rows]) => rows);
  for (const [title, rows] of sections) printReport(title, rows);

  const failCount = allRows.filter((row) => row.status === 'FAIL').length;
  const warnCount = allRows.filter((row) => row.status === 'WARN').length;
  console.log(`\nSummary: ${failCount} FAIL, ${warnCount} WARN`);
  if (failCount > 0) process.exitCode = 2;
}

async function migrateIndexes(db) {
  const apply = flags.has('--apply');
  const backupConfirmed = flags.has('--backup-confirmed');
  const collection = await getCollection(db, 'printjobs');
  if (!collection) {
    console.log('[WARN] printjobs collection missing; nothing to migrate');
    return;
  }

  const duplicateRows = await auditDuplicateOpenPrintJobs(db);
  const hasDuplicateFailure = duplicateRows.some(
    (row) => row.status === 'FAIL',
  );
  if (hasDuplicateFailure) {
    printReport('Preflight duplicate check', duplicateRows);
    throw new Error(
      'Cannot create print job unique index while duplicates exist',
    );
  }

  const indexes = await collection.indexes();
  const oldIndexes = indexes.filter((index) =>
    sameKey(index.key, OLD_PRINT_JOB_KEY),
  );
  const hasNewIndex = indexes.some(
    (index) =>
      sameKey(index.key, NEW_PRINT_JOB_KEY) &&
      index.unique === true &&
      isOpenPrintPartial(index.partialFilterExpression),
  );

  if (!apply) {
    console.log('[DRY-RUN] migrate print job indexes');
    console.log(
      `[DRY-RUN] old indexes to drop: ${
        oldIndexes.map((index) => index.name).join(', ') || '<none>'
      }`,
    );
    console.log(
      `[DRY-RUN] new index to create: ${hasNewIndex ? '<already exists>' : NEW_PRINT_JOB_INDEX_NAME}`,
    );
    return;
  }

  if (!backupConfirmed) {
    throw new Error(
      'Refusing to apply index migration without --backup-confirmed',
    );
  }

  for (const index of oldIndexes) {
    console.log(`[APPLY] dropping old print job index ${index.name}`);
    await collection.dropIndex(index.name);
  }

  if (!hasNewIndex) {
    console.log(`[APPLY] creating ${NEW_PRINT_JOB_INDEX_NAME}`);
    await collection.createIndex(NEW_PRINT_JOB_KEY, {
      name: NEW_PRINT_JOB_INDEX_NAME,
      unique: true,
      partialFilterExpression: {
        status: { $in: OPEN_PRINT_STATUSES },
      },
    });
  } else {
    console.log('[PASS] new print job index already exists');
  }
}

async function main() {
  if (flags.has('--help') || command === 'help') {
    usage();
    return;
  }

  if (!['audit', 'migrate-indexes'].includes(command)) {
    usage();
    throw new Error(`Unknown command: ${command}`);
  }

  loadDotEnv();
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is required');
  }

  console.log(`Connecting to MongoDB ${redactMongoUri(uri)}`);
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
  });

  try {
    const db = mongoose.connection.db;
    if (command === 'audit') {
      await auditProductionReadiness(db);
    } else {
      await migrateIndexes(db);
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(`[FAIL] ${error.message}`);
  process.exitCode = process.exitCode || 1;
});
