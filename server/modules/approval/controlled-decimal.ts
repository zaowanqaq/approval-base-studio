import { BadRequestException } from '@nestjs/common';

export type DecimalRounding = 'half-up' | 'down' | 'up';

interface DecimalValue {
  units: bigint;
  scale: number;
}

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,6})?$/u;

export function evaluateDecimalOperation(
  operation: 'sum' | 'average' | 'min' | 'max' | 'add' | 'subtract' | 'multiply' | 'divide',
  values: unknown[],
  scale: number,
  rounding: DecimalRounding,
): string {
  if (values.length < 2) {
    throw new BadRequestException('受控计算至少需要两个数字来源');
  }
  const decimals = values.map((value: unknown) => parseDecimal(value));
  let result: DecimalValue;
  if (operation === 'sum' || operation === 'add') {
    result = decimals.reduce((left: DecimalValue, right: DecimalValue) => add(left, right));
  } else if (operation === 'average') {
    const total = decimals.reduce((left: DecimalValue, right: DecimalValue) => add(left, right));
    result = divide(total, { units: BigInt(decimals.length), scale: 0 }, scale, rounding);
  } else if (operation === 'min' || operation === 'max') {
    result = decimals.reduce((left: DecimalValue, right: DecimalValue) => {
      const comparison = compare(left, right);
      return operation === 'min'
        ? comparison <= 0 ? left : right
        : comparison >= 0 ? left : right;
    });
  } else if (operation === 'subtract') {
    result = decimals.slice(1).reduce(
      (left: DecimalValue, right: DecimalValue) => subtract(left, right),
      decimals[0],
    );
  } else if (operation === 'multiply') {
    result = decimals.slice(1).reduce(
      (left: DecimalValue, right: DecimalValue) => multiply(left, right),
      decimals[0],
    );
  } else {
    result = decimals.slice(1).reduce(
      (left: DecimalValue, right: DecimalValue) => divide(left, right, scale, rounding),
      decimals[0],
    );
  }
  return render(result, scale, rounding);
}

function parseDecimal(value: unknown): DecimalValue {
  const text = value instanceof Date ? value.toISOString() : String(value ?? '').trim();
  if (!DECIMAL_PATTERN.test(text)) {
    throw new BadRequestException(`受控计算来源“${text}”不是受支持的十进制数字`);
  }
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [integerPart, fractionPart = ''] = unsigned.split('.');
  const units = BigInt(`${integerPart}${fractionPart}`);
  return {
    units: negative ? -units : units,
    scale: fractionPart.length,
  };
}

function add(left: DecimalValue, right: DecimalValue): DecimalValue {
  const scale = Math.max(left.scale, right.scale);
  return {
    units: scaleUnits(left, scale) + scaleUnits(right, scale),
    scale,
  };
}

function subtract(left: DecimalValue, right: DecimalValue): DecimalValue {
  return add(left, { units: -right.units, scale: right.scale });
}

function multiply(left: DecimalValue, right: DecimalValue): DecimalValue {
  return { units: left.units * right.units, scale: left.scale + right.scale };
}

function divide(
  left: DecimalValue,
  right: DecimalValue,
  scale: number,
  rounding: DecimalRounding,
): DecimalValue {
  if (right.units === 0n) throw new BadRequestException('受控计算不能除以零');
  const exponent = right.scale - left.scale + scale;
  const numerator = exponent >= 0 ? left.units * powerOfTen(exponent) : left.units;
  const denominator = exponent >= 0 ? right.units : right.units * powerOfTen(-exponent);
  return { units: roundedQuotient(numerator, denominator, rounding), scale };
}

function compare(left: DecimalValue, right: DecimalValue): number {
  const scale = Math.max(left.scale, right.scale);
  const leftUnits = scaleUnits(left, scale);
  const rightUnits = scaleUnits(right, scale);
  return leftUnits < rightUnits ? -1 : leftUnits > rightUnits ? 1 : 0;
}

function scaleUnits(value: DecimalValue, scale: number): bigint {
  return value.units * powerOfTen(scale - value.scale);
}

function roundedQuotient(numerator: bigint, denominator: bigint, rounding: DecimalRounding): bigint {
  const sign = (numerator < 0n) === (denominator < 0n) ? 1n : -1n;
  const positiveNumerator = numerator < 0n ? -numerator : numerator;
  const positiveDenominator = denominator < 0n ? -denominator : denominator;
  let quotient = positiveNumerator / positiveDenominator;
  const remainder = positiveNumerator % positiveDenominator;
  const shouldRound = rounding === 'up'
    ? remainder !== 0n
    : rounding === 'half-up'
      ? remainder * 2n >= positiveDenominator
      : false;
  if (shouldRound) quotient += 1n;
  return sign * quotient;
}

function render(value: DecimalValue, scale: number, rounding: DecimalRounding): string {
  const units = scale === value.scale
    ? value.units
    : scale < value.scale
      ? roundedQuotient(value.units, powerOfTen(value.scale - scale), rounding)
      : value.units * powerOfTen(scale - value.scale);
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const text = absolute.toString().padStart(scale + 1, '0');
  if (scale === 0) return `${negative ? '-' : ''}${text}`;
  const splitAt = text.length - scale;
  const fraction = text.slice(splitAt).replace(/0+$/u, '');
  return `${negative ? '-' : ''}${text.slice(0, splitAt)}${fraction ? `.${fraction}` : ''}`;
}

function powerOfTen(exponent: number): bigint {
  let result = 1n;
  for (let index = 0; index < exponent; index += 1) result *= 10n;
  return result;
}
