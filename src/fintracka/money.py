from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation


class MoneyError(ValueError):
    pass


_CURRENCY = re.compile(r"^[A-Z]{3}$")
_ZERO_DECIMAL = {"BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"}
_THREE_DECIMAL = {"BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"}


def currency_exponent(currency: str) -> int:
    if not _CURRENCY.fullmatch(currency):
        raise MoneyError("currency must be a three-letter uppercase code")
    if currency in _ZERO_DECIMAL:
        return 0
    if currency in _THREE_DECIMAL:
        return 3
    return 2


def minor_units(value: str | int | Decimal, currency: str) -> int:
    if isinstance(value, bool) or isinstance(value, float):
        raise MoneyError("money must be supplied as text, Decimal, or whole major units")
    try:
        amount = Decimal(value)
    except (InvalidOperation, ValueError) as error:
        raise MoneyError("invalid money value") from error
    if not amount.is_finite():
        raise MoneyError("money must be finite")
    scale = Decimal(10) ** currency_exponent(currency)
    scaled = amount * scale
    if scaled != scaled.to_integral_value():
        raise MoneyError(f"{currency} amount has too many fractional digits")
    return int(scaled)

