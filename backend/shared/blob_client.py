import os
from azure.storage.blob import BlobServiceClient


def get_blob_client(container: str, blob_name: str):
    conn_str = os.environ["AzureWebJobsStorage"]
    service = BlobServiceClient.from_connection_string(conn_str)
    return service.get_blob_client(container=container, blob=blob_name)
