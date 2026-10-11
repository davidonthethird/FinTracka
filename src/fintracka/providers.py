from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class NormalizedAccount:
    external_id: str
    name: str
    account_type: str
    subtype: str | None
    nature: str
    currency: str = "USD"
    mask: str | None = None


@dataclass(frozen=True)
class NormalizedBalance:
    account_external_id: str
    observed_at: str
    current_minor: int
    available_minor: int | None = None
    currency: str = "USD"
    source: str = "provider"


@dataclass(frozen=True)
class NormalizedTransaction:
    external_id: str
    account_external_id: str
    occurred_at: str
    amount_minor: int
    currency: str
    description: str
    merchant: str | None = None
    pending: bool = False
    pending_external_id: str | None = None


@dataclass(frozen=True)
class SyncBatch:
    accounts: tuple[NormalizedAccount, ...] = field(default_factory=tuple)
    balances: tuple[NormalizedBalance, ...] = field(default_factory=tuple)
    added: tuple[NormalizedTransaction, ...] = field(default_factory=tuple)
    modified: tuple[NormalizedTransaction, ...] = field(default_factory=tuple)
    removed: tuple[str, ...] = field(default_factory=tuple)
    next_checkpoint: str | None = None
    provider_status: str = "ok"
    raw_response_hashes: tuple[str, ...] = field(default_factory=tuple)

