import logging
import azure.functions as func


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("build_report triggered")

    customer_id = req.params.get("customer_id")
    if not customer_id:
        return func.HttpResponse("customer_id is required", status_code=400)

    # TODO: generate HTML/PDF report and store in Blob Storage
    return func.HttpResponse(f"Report queued for {customer_id}", status_code=202)
