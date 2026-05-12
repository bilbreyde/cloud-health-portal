"""
One-time import script for Zones exceptions xlsx/csv files.

Usage:
    python import_exceptions.py \
        --customer-id 5c96ec2a-1b2f-4642-be6e-e2f1c3503d90 \
        --file Zones_Exceptions_11226.xlsx \
        --api-url https://chp-dev-func.azurewebsites.net
"""

import argparse
import os
import sys

import requests


def main() -> None:
    parser = argparse.ArgumentParser(description='Import exceptions from xlsx/csv to the portal API')
    parser.add_argument('--customer-id', required=True)
    parser.add_argument('--file', required=True)
    parser.add_argument('--api-url', default='https://chp-dev-func.azurewebsites.net')
    args = parser.parse_args()

    file_path = args.file
    if not os.path.isfile(file_path):
        print(f'ERROR: file not found: {file_path}', file=sys.stderr)
        sys.exit(1)

    url = f"{args.api_url.rstrip('/')}/api/exceptions/{args.customer_id}/import"
    print(f'Uploading {file_path} -> {url}')

    with open(file_path, 'rb') as f:
        resp = requests.post(url, files={'file': (os.path.basename(file_path), f, 'application/octet-stream')})

    if resp.ok:
        data = resp.json()
        print(f"✓ Imported {data.get('imported', 0)} exceptions")
        errs = data.get('errors', [])
        if errs:
            print(f"  {len(errs)} rows had errors:")
            for e in errs[:10]:
                print(f"    row {e['row']}: {e['error']}")
    else:
        print(f'ERROR {resp.status_code}: {resp.text}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
