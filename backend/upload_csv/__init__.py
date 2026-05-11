import logging
import azure.functions as func


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("upload_csv triggered")

    if req.method != "POST":
        return func.HttpResponse("Method not allowed", status_code=405)

    file = req.files.get("file")
    if not file:
        return func.HttpResponse("No file provided", status_code=400)

    # TODO: validate CSV and upload to Blob Storage
    return func.HttpResponse("Upload received", status_code=202)
