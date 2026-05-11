from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional


@dataclass
class Customer:
    id: str
    name: str
    slug: str
    created_at: datetime
    settings: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "customerId": self.id,
            "name": self.name,
            "slug": self.slug,
            "created_at": self.created_at.isoformat(),
            "settings": self.settings,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Customer":
        return cls(
            id=d["id"],
            name=d["name"],
            slug=d["slug"],
            created_at=datetime.fromisoformat(d["created_at"]),
            settings=d.get("settings", {}),
        )


@dataclass
class Upload:
    id: str
    customerId: str
    month: int
    year: int
    serviceType: str
    fileName: str
    blobPath: str
    uploadedAt: datetime
    status: str              # pending | processing | complete | failed
    snapshotDate: str = ''   # ISO date of the CloudHealth export
    savingsTotal: float = 0.0
    snapshotNumber: int = 1
    isRelabeled: bool = False

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "customerId": self.customerId,
            "month": self.month,
            "year": self.year,
            "serviceType": self.serviceType,
            "fileName": self.fileName,
            "blobPath": self.blobPath,
            "uploadedAt": self.uploadedAt.isoformat(),
            "status": self.status,
            "snapshotDate": self.snapshotDate,
            "savingsTotal": self.savingsTotal,
            "snapshotNumber": self.snapshotNumber,
            "isRelabeled": self.isRelabeled,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Upload":
        return cls(
            id=d["id"],
            customerId=d["customerId"],
            month=d["month"],
            year=d["year"],
            serviceType=d["serviceType"],
            fileName=d["fileName"],
            blobPath=d["blobPath"],
            uploadedAt=datetime.fromisoformat(d["uploadedAt"]),
            status=d["status"],
            snapshotDate=d.get("snapshotDate", ""),
            savingsTotal=d.get("savingsTotal", 0.0),
            snapshotNumber=d.get("snapshotNumber", 1),
            isRelabeled=d.get("isRelabeled", False),
        )


@dataclass
class TrendData:
    id: str
    customerId: str
    month: int
    year: int
    serviceType: str
    reportKey: str
    savingsTotal: float
    rowCount: int
    momDelta: float        # month-over-month delta (stored as 0 at upload; recomputed by run_trends)
    direction: str         # Up | Down | Flat
    snapshotDate: str = ''    # ISO date of the CloudHealth export e.g. "2026-04-30"
    snapshotNumber: int = 1   # 1, 2, 3 … within (month, year, serviceType)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "customerId": self.customerId,
            "month": self.month,
            "year": self.year,
            "serviceType": self.serviceType,
            "reportKey": self.reportKey,
            "savingsTotal": self.savingsTotal,
            "rowCount": self.rowCount,
            "momDelta": self.momDelta,
            "direction": self.direction,
            "snapshotDate": self.snapshotDate,
            "snapshotNumber": self.snapshotNumber,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "TrendData":
        return cls(
            id=d["id"],
            customerId=d["customerId"],
            month=d["month"],
            year=d["year"],
            serviceType=d["serviceType"],
            reportKey=d["reportKey"],
            savingsTotal=d["savingsTotal"],
            rowCount=d["rowCount"],
            momDelta=d["momDelta"],
            direction=d["direction"],
            snapshotDate=d.get("snapshotDate", ""),
            snapshotNumber=d.get("snapshotNumber", 1),
        )


@dataclass
class Report:
    id: str
    customerId: str
    month: int
    year: int
    status: str            # draft | review | final
    blobPath: str
    generatedAt: datetime
    joelNotes: Optional[str] = None
    narrativeDraft: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "customerId": self.customerId,
            "month": self.month,
            "year": self.year,
            "status": self.status,
            "blobPath": self.blobPath,
            "generatedAt": self.generatedAt.isoformat(),
            "joelNotes": self.joelNotes,
            "narrativeDraft": self.narrativeDraft,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Report":
        return cls(
            id=d["id"],
            customerId=d["customerId"],
            month=d["month"],
            year=d["year"],
            status=d["status"],
            blobPath=d["blobPath"],
            generatedAt=datetime.fromisoformat(d["generatedAt"]),
            joelNotes=d.get("joelNotes"),
            narrativeDraft=d.get("narrativeDraft"),
        )


@dataclass
class Template:
    id: str
    customerId: str
    fileName: str
    blobPath: str
    isActive: bool
    uploadedAt: datetime

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "customerId": self.customerId,
            "fileName": self.fileName,
            "blobPath": self.blobPath,
            "isActive": self.isActive,
            "uploadedAt": self.uploadedAt.isoformat(),
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Template":
        return cls(
            id=d["id"],
            customerId=d["customerId"],
            fileName=d["fileName"],
            blobPath=d["blobPath"],
            isActive=d["isActive"],
            uploadedAt=datetime.fromisoformat(d["uploadedAt"]),
        )
