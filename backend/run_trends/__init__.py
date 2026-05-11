import logging
import azure.functions as func


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("run_trends triggered")

    customer_id = req.params.get("customer_id")
    if not customer_id:
        return func.HttpResponse("customer_id is required", status_code=400)

    # TODO: load CSV from Blob, run trend analysis with pandas
    return func.HttpResponse(f"Trends queued for {customer_id}", status_code=202)
