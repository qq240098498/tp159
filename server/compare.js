const { badRequest } = require('./errors');
const { load } = require('./store');
const pricing = require('./pricing');
const zones = require('./zones');
const { findCustomer } = require('./customers');
const { periodOf, zoneOf } = require('./bills');

// 选批：优先按显式勾选的运单；否则按客户 + 账期（与出账口径 candidateWaybills 一致）
function selectWaybills(data, payload) {
  const rawIds = Array.isArray(payload && payload.waybillIds) ? payload.waybillIds : [];
  const ids = rawIds.map((id) => String(id == null ? '' : id).trim()).filter(Boolean);
  if (ids.length > 0) {
    const picked = [];
    const missing = [];
    ids.forEach((id) => {
      const waybill = data.waybills.find((item) => item.id === id);
      if (waybill) picked.push(waybill);
      else missing.push(id);
    });
    if (missing.length > 0) throw badRequest('COMPARE_WAYBILL_NOT_FOUND', '有运单不存在：' + missing.join('、'));
    // 保持运单在数据里的先后顺序，去掉重复勾选
    return data.waybills.filter((waybill) => ids.includes(waybill.id));
  }
  const customerId = String((payload && payload.customerId) || '').trim();
  const period = String((payload && payload.period) || '').trim();
  if (!customerId) throw badRequest('COMPARE_CUSTOMER_REQUIRED', '要选一个客户，或直接勾选运单', { field: 'customerId' });
  if (!/^[0-9]{4}-[0-9]{2}$/.test(period)) {
    throw badRequest('COMPARE_PERIOD_INVALID', '账期要形如 2026-09，或直接勾选运单', { field: 'period' });
  }
  return data.waybills.filter((waybill) => waybill.customerId === customerId && periodOf(waybill) === period);
}

// 单条口径：每条运单按自己的收件城市（含别名）归属分区，各算各的首重续重、最低收费、附加费
function priceSingle(waybill, data, settings) {
  const zone = zones.zoneOfCity(data, waybill.toCity);
  const customer = findCustomer(data, waybill.customerId);
  const quote = pricing.quoteWaybill(waybill, zone, customer, settings);
  return {
    zoneId: zone ? zone.id : null,
    zoneName: zone ? zone.name : '未归属',
    billableKg: quote.billableKg,
    freightYuan: quote.freightYuan,
    surchargeYuan: quote.surchargeYuan,
    grossYuan: quote.grossYuan,
    totalYuan: quote.totalYuan,
  };
}

// 整批口径：与 bills.priceBill 完全同款——
// 分区只取第一条运单的收件城市、只在分区直接登记的城市里匹配（不看别名，查不到落到第一个分区）；
// 各单计费重量相加，整批只算一次首重续重、只兜底一次最低收费；附加费逐单算后求和；
// 运费按各单计费重量占比分摊，折扣在整批合计上只作用一次。
function priceBatch(data, customer, waybills) {
  const settings = pricing.settingsOf(data);
  const permille = pricing.discountPermilleOf(customer);
  const zone = zoneOf(data, waybills[0].toCity);
  const weights = waybills.map((waybill) => pricing.billableWeightKg(waybill, settings));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const freightAll = pricing.freightYuan(zone, totalWeight, settings);
  const surcharges = waybills.map((waybill, index) => pricing.surchargeYuan(zone, waybill, weights[index], settings));
  const surchargeAll = surcharges.reduce((sum, value) => sum + value, 0);
  const lines = waybills.map((waybill, index) => {
    const weight = weights[index];
    const share = totalWeight > 0 ? weight / totalWeight : 0;
    const freightLine = freightAll * share;
    const surcharge = surcharges[index];
    const total = pricing.roundFen((freightLine + surcharge) * permille / 1000);
    return {
      zoneId: zone ? zone.id : null,
      zoneName: zone ? zone.name : '',
      billableKg: weight,
      freightYuan: pricing.roundFen(freightLine),
      surchargeYuan: pricing.roundFen(surcharge),
      grossYuan: pricing.roundFen(freightLine + surcharge),
      totalYuan: total,
    };
  });
  const amountYuan = (freightAll + surchargeAll) * permille / 1000;
  return {
    zone,
    permille,
    totalWeight,
    freightAll: pricing.roundFen(freightAll),
    surchargeAll: pricing.roundFen(surchargeAll),
    amountYuan,
    lines,
  };
}

function comparePricing(payload) {
  const data = load();
  const waybills = selectWaybills(data, payload);
  if (waybills.length === 0) throw badRequest('COMPARE_NO_WAYBILL', '选出来的范围里没有运单，换个客户/账期或重新勾选');
  const settings = pricing.settingsOf(data);

  // 以批内第一条运单所属客户作为整批折扣口径（出账本就按客户出）
  const batchCustomer = findCustomer(data, waybills[0].customerId);
  const batch = priceBatch(data, batchCustomer, waybills);

  const customerMixed = waybills.some((waybill) => waybill.customerId !== waybills[0].customerId);
  const singleZones = waybills.map((waybill) => {
    const zone = zones.zoneOfCity(data, waybill.toCity);
    return zone ? zone.id : '';
  });
  const zoneMixed = Array.from(new Set(singleZones)).length > 1;
  // 整批口径的分区与各单按自己城市归属的分区不一致（第一条同城市时也可能因别名口径不同而不同）
  const batchZoneId = batch.zone ? batch.zone.id : '';
  const zoneMismatched = waybills.some((waybill, index) => singleZones[index] !== batchZoneId);

  const lines = waybills.map((waybill, index) => {
    const single = priceSingle(waybill, data, settings);
    const batchLine = batch.lines[index];
    const customer = findCustomer(data, waybill.customerId);
    return {
      waybillId: waybill.id,
      code: waybill.code,
      customerId: waybill.customerId,
      customerName: customer ? customer.name : '（客户已删）',
      fromCity: waybill.fromCity,
      toCity: waybill.toCity,
      pieces: Number(waybill.pieces || 1),
      weightKg: Number(waybill.weightKg) || 0,
      volumeM3: Number(waybill.volumeM3) || 0,
      insuredAmountYuan: Number(waybill.insuredAmountYuan) || 0,
      services: Array.isArray(waybill.services) ? waybill.services : [],
      createdAt: waybill.createdAt,
      singleZoneMismatch: single.zoneId !== batchLine.zoneId,
      single,
      batch: batchLine,
      diff: {
        billableKg: pricing.roundFen(single.billableKg - batchLine.billableKg),
        freightYuan: pricing.roundFen(single.freightYuan - batchLine.freightYuan),
        surchargeYuan: pricing.roundFen(single.surchargeYuan - batchLine.surchargeYuan),
        totalYuan: pricing.roundFen(single.totalYuan - batchLine.totalYuan),
      },
    };
  });

  const sumOf = (list, pick) => list.reduce((sum, item) => sum + Number(pick(item) || 0), 0);
  const singleTotals = {
    billableKg: pricing.roundFen(sumOf(lines, (line) => line.single.billableKg)),
    freightYuan: pricing.roundFen(sumOf(lines, (line) => line.single.freightYuan)),
    surchargeYuan: pricing.roundFen(sumOf(lines, (line) => line.single.surchargeYuan)),
    totalYuan: pricing.roundFen(sumOf(lines, (line) => line.single.totalYuan)),
  };
  const batchTotals = {
    billableKg: pricing.roundFen(batch.totalWeight),
    freightYuan: batch.freightAll,
    surchargeYuan: batch.surchargeAll,
    // 与账单 amountYuan 保持一致：整批折扣额不逐分四舍五入
    totalYuan: pricing.roundFen(batch.amountYuan),
  };
  const totals = {
    single: singleTotals,
    batch: batchTotals,
    diff: {
      billableKg: pricing.roundFen(singleTotals.billableKg - batchTotals.billableKg),
      freightYuan: pricing.roundFen(singleTotals.freightYuan - batchTotals.freightYuan),
      surchargeYuan: pricing.roundFen(singleTotals.surchargeYuan - batchTotals.surchargeYuan),
      totalYuan: pricing.roundFen(singleTotals.totalYuan - batchTotals.totalYuan),
    },
  };

  return {
    basis: {
      customerId: batchCustomer ? batchCustomer.id : '',
      customerName: batchCustomer ? batchCustomer.name : '（客户已删）',
      waybillCount: waybills.length,
    },
    discountPermille: batch.permille,
    batchZone: batch.zone ? { id: batch.zone.id, code: batch.zone.code, name: batch.zone.name } : null,
    flags: {
      customerMixed,
      zoneMixed,
      zoneMismatched,
    },
    lines,
    totals,
  };
}

module.exports = { comparePricing };
