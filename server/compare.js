const { badRequest } = require('./errors');
const { load } = require('./store');
const pricing = require('./pricing');
const zones = require('./zones');
const bills = require('./bills');
const { findCustomer } = require('./customers');

// 双口径试算：同一批运单按两种口径各算一遍并排对比，只算不写
// 单条口径 = pricing.quoteWaybill（运单详情页「单条计费」的算法）
// 整批口径 = bills.priceBill 的算法（出账用）；试算不读运单上的计费缓存，全部按当前数据重算

// 单条口径：每单按自己的收件城市找分区（先别名后城市），找不到分区的单这一侧算不出
function singleRow(data, waybill, customer, settings) {
  const zone = zones.zoneOfCity(data, waybill.toCity);
  if (!zone) {
    return { zoneKnown: false, zoneId: null, zoneName: '', billableKg: null, freightYuan: null, surchargeYuan: null, totalYuan: null };
  }
  const quote = pricing.quoteWaybill(waybill, zone, customer, settings);
  return {
    zoneKnown: true,
    zoneId: zone.id,
    zoneName: zone.name,
    billableKg: quote.billableKg,
    freightYuan: quote.freightYuan,
    surchargeYuan: quote.surchargeYuan,
    totalYuan: quote.totalYuan,
  };
}

// 整批口径：与 bills.priceBill 同一套算法
// 共享分区取第一单的收件城市（只按登记城市直接匹配，不认别名，匹配不上退到第一个分区）；
// 重量加总只算一次首重续重，再按每单重量占比分摊；附加费仍逐单算，但偏远附加按共享分区
function batchRows(data, waybills, customer, settings) {
  const sharedZone = bills.zoneOf(data, waybills[0].toCity);
  if (!sharedZone) return { sharedZone: null, zoneMatched: false, rows: [] };
  const sourceCity = zones.cleanCity(waybills[0].toCity);
  const zoneMatched = (sharedZone.cities || []).map(zones.cleanCity).indexOf(sourceCity) >= 0;
  const permille = pricing.discountPermilleOf(customer);
  const weights = waybills.map((waybill) => pricing.billableWeightKg(waybill, settings));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const freightAll = pricing.freightYuan(sharedZone, totalWeight, settings);
  const rows = waybills.map((waybill, index) => {
    const weight = weights[index];
    const share = totalWeight > 0 ? weight / totalWeight : 0;
    const freightRaw = freightAll * share;
    const surchargeRaw = pricing.surchargeYuan(sharedZone, waybill, weight, settings);
    return {
      zoneId: sharedZone.id,
      zoneName: sharedZone.name,
      billableKg: weight,
      freightYuan: pricing.roundFen(freightRaw),
      surchargeYuan: pricing.roundFen(surchargeRaw),
      totalYuan: pricing.roundFen((freightRaw + surchargeRaw) * permille / 1000),
    };
  });
  return { sharedZone, zoneMatched, rows };
}

function sumRows(rows, side) {
  let freight = 0;
  let surcharge = 0;
  let total = 0;
  let count = 0;
  rows.forEach((row) => {
    const part = row[side];
    if (!part || part.totalYuan === null || part.totalYuan === undefined) return;
    freight += Number(part.freightYuan) || 0;
    surcharge += Number(part.surchargeYuan) || 0;
    total += Number(part.totalYuan) || 0;
    count += 1;
  });
  return {
    pricedCount: count,
    freightYuan: pricing.roundFen(freight),
    surchargeYuan: pricing.roundFen(surcharge),
    totalYuan: pricing.roundFen(total),
  };
}

// 算法差异说明：回答「重量是否合并、分区是否取同一块、附加费是否重复计算」，并带上本批的实际取值
function buildNotes(waybills, sharedZone, zoneMatched) {
  const count = waybills.length;
  const first = waybills[0];
  const zoneText = sharedZone ? (sharedZone.name + '（' + sharedZone.code + '）') : '（还没有任何分区）';
  const matchedText = sharedZone
    ? (zoneMatched
      ? '，按登记城市直接匹配上'
      : '；「' + first.toCity + '」没匹配上任何分区的登记城市，退到了第一个分区')
    : '';
  return [
    '重量是否合并：单条口径每单各自算一次首重续重、各自过一次最低收费（' + count + ' 单就收 ' + count + ' 次首重）；整批口径把整批计费重量加总后只算一次首重续重、只过一次最低收费，再按每单重量占比把运费分摊回每单。单票越轻、单数越多，整批口径越便宜。',
    '分区是否取同一块：单条口径每单按自己的收件城市各找分区（先匹配别名再匹配登记城市）；整批口径全批共用一块分区——取第一单 ' + first.code + ' 的收件城市「' + first.toCity + '」' + matchedText + '，且不识别别名。本批共享分区：' + zoneText + '，全批运费与偏远附加都按这块分区的价格算。',
    '附加费是否重复计算：偏远附加在单条口径下按每单自己的分区收（有的分区为 0）；整批口径下每单都按共享分区收一次（' + count + ' 单收 ' + count + ' 次）。超规附加与保价费两种口径都按单各自收，算法相同。',
    '取整与缓存：单条口径逐单保留两位；整批口径逐行分摊保留两位，但正式出账的账单金额是未取整的（运费＋附加费）×折扣，可能与行合计差几分钱。正式出账时，有计费缓存的运单直接取缓存金额；本试算不读缓存，全部按当前数据重算。',
  ];
}

function compareBatch(query) {
  const data = load();
  const period = String((query && query.period) || '').trim();
  const customerId = String((query && query.customerId) || '').trim();
  if (!/^[0-9]{4}-[0-9]{2}$/.test(period)) throw badRequest('COMPARE_PERIOD_INVALID', '账期要形如 2026-09', { field: 'period' });
  const customer = findCustomer(data, customerId);
  if (!customer) throw badRequest('COMPARE_CUSTOMER_REQUIRED', '要选一个客户', { field: 'customerId' });
  const targets = bills.candidateWaybills(data, period, customerId);
  if (targets.length === 0) throw badRequest('COMPARE_NO_WAYBILL', '这个账期里这个客户没有运单，换一批再试', { field: 'period' });

  const settings = pricing.settingsOf(data);
  const permille = pricing.discountPermilleOf(customer);
  const batch = batchRows(data, targets, customer, settings);

  const rows = targets.map((waybill, index) => {
    const single = singleRow(data, waybill, customer, settings);
    const batched = batch.rows[index] || null;
    const diffYuan = (single.totalYuan !== null && batched) ? pricing.roundFen(single.totalYuan - batched.totalYuan) : null;
    return {
      waybillId: waybill.id,
      code: waybill.code,
      toCity: waybill.toCity,
      hasQuoteCache: Number(waybill.quoteCacheYuan) > 0,
      single,
      batch: batched,
      diffYuan,
    };
  });

  const singleTotals = sumRows(rows, 'single');
  const batchTotals = sumRows(rows, 'batch');
  const zoneDifferCount = rows.filter((row) => row.single.zoneKnown && row.batch && row.single.zoneId !== row.batch.zoneId).length;
  const unzonedCities = rows.filter((row) => !row.single.zoneKnown).map((row) => row.toCity);
  const cachedCodes = rows.filter((row) => row.hasQuoteCache).map((row) => row.code);

  const sharedZone = batch.sharedZone
    ? { id: batch.sharedZone.id, code: batch.sharedZone.code, name: batch.sharedZone.name, sourceCity: targets[0].toCity, matched: batch.zoneMatched }
    : null;

  return {
    period,
    customer: { id: customer.id, code: customer.code, name: customer.name, settle: customer.settle, discountPermille: permille },
    waybillCount: rows.length,
    sharedZone,
    rows,
    totals: {
      single: singleTotals,
      batch: batchTotals,
      diffYuan: pricing.roundFen(singleTotals.totalYuan - batchTotals.totalYuan),
    },
    zoneDifferCount,
    unzonedCities,
    cachedCodes,
    notes: buildNotes(targets, batch.sharedZone, batch.zoneMatched),
  };
}

module.exports = { compareBatch };
