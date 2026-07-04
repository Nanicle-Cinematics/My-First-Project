'use strict';

const { Prisma } = require('@prisma/client');

const EXCLUDED_MODELS = new Set(['PasswordResetToken']);
const SECRET_FIELDS = new Set(['passwordHash', 'totpSecret', 'totpRecoveryCodes']);

function delegateName(modelName) {
  return modelName.charAt(0).toLowerCase() + modelName.slice(1);
}

function exportableTenantModels() {
  return Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === 'churchId'))
    .filter((model) => !EXCLUDED_MODELS.has(model.name))
    .map((model) => ({ model: model.name, delegate: delegateName(model.name) }));
}

function sanitizeExportValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeExportValue);
  if (!value || typeof value !== 'object') return value;
  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (!SECRET_FIELDS.has(key)) clean[key] = sanitizeExportValue(child);
  }
  return clean;
}

async function exportTenantData(rawDb, churchId) {
  const church = await rawDb.church.findUnique({ where: { id: churchId } });
  if (!church) throw new Error('Church not found');
  const data = {};
  for (const { model, delegate } of exportableTenantModels()) {
    data[model] = sanitizeExportValue(await rawDb[delegate].findMany({ where: { churchId } }));
  }
  return {
    format: 'church-manager-tenant-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    church: sanitizeExportValue(church),
    data,
  };
}

module.exports = { exportTenantData, exportableTenantModels, sanitizeExportValue };
