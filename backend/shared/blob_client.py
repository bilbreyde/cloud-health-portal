import os
from typing import Optional

from azure.core.exceptions import ResourceExistsError
from azure.storage.blob import BlobServiceClient, ContentSettings

_CONTAINER_NAME = "cloud-health-portal"


def _get_service() -> BlobServiceClient:
    conn_str = os.environ["STORAGE_CONNECTION_STRING"]
    return BlobServiceClient.from_connection_string(conn_str)


def _ensure_container() -> None:
    try:
        _get_service().create_container(_CONTAINER_NAME)
    except ResourceExistsError:
        pass


def _get_blob(blob_path: str):
    return _get_service().get_blob_client(container=_CONTAINER_NAME, blob=blob_path)


def _csv_path(customer_id: str, month: int, year: int, service_type: str, filename: str) -> str:
    return f"{customer_id}/csvs/{year}/{month:02d}/{service_type}/{filename}"


def _report_path(customer_id: str, month: int, year: int, filename: str) -> str:
    return f"{customer_id}/reports/{year}/{month:02d}/{filename}"


def _template_path(customer_id: str, filename: str) -> str:
    return f"{customer_id}/templates/{filename}"


def upload_csv(
    customer_id: str,
    month: int,
    year: int,
    service_type: str,
    file_bytes: bytes,
    filename: str,
) -> str:
    """Upload a cost CSV and return its blob path."""
    _ensure_container()
    blob_path = _csv_path(customer_id, month, year, service_type, filename)
    client = _get_blob(blob_path)
    client.upload_blob(
        file_bytes,
        overwrite=True,
        content_settings=ContentSettings(content_type="text/csv"),
    )
    return blob_path


def upload_report(
    customer_id: str,
    month: int,
    year: int,
    file_bytes: bytes,
    filename: str,
) -> str:
    """Upload a generated report and return its blob path."""
    _ensure_container()
    blob_path = _report_path(customer_id, month, year, filename)
    client = _get_blob(blob_path)
    content_type = "application/pdf" if filename.endswith(".pdf") else "text/html"
    client.upload_blob(
        file_bytes,
        overwrite=True,
        content_settings=ContentSettings(content_type=content_type),
    )
    return blob_path


def upload_docx(
    customer_id: str,
    month: int,
    year: int,
    file_bytes: bytes,
    filename: str,
) -> str:
    """Upload an imported .docx report and return its blob path."""
    _ensure_container()
    safe_name = f"imported_{filename}"
    blob_path = _report_path(customer_id, month, year, safe_name)
    client = _get_blob(blob_path)
    client.upload_blob(
        file_bytes,
        overwrite=True,
        content_settings=ContentSettings(
            content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ),
    )
    return blob_path


def upload_template(
    customer_id: str,
    file_bytes: bytes,
    filename: str,
) -> str:
    """Upload a report template and return its blob path."""
    _ensure_container()
    blob_path = _template_path(customer_id, filename)
    client = _get_blob(blob_path)
    client.upload_blob(
        file_bytes,
        overwrite=True,
        content_settings=ContentSettings(content_type="application/octet-stream"),
    )
    return blob_path


def download_file(blob_path: str) -> bytes:
    """Download any blob by its full path."""
    client = _get_blob(blob_path)
    return client.download_blob().readall()


def list_uploads(
    customer_id: str,
    month: Optional[int] = None,
    year: Optional[int] = None,
) -> list[str]:
    """Return blob paths for uploaded CSVs, optionally filtered by year/month."""
    service = _get_service()
    container = service.get_container_client(_CONTAINER_NAME)

    prefix = f"{customer_id}/csvs/"
    if year is not None:
        prefix += f"{year}/"
        if month is not None:
            prefix += f"{month:02d}/"

    return [b.name for b in container.list_blobs(name_starts_with=prefix)]
