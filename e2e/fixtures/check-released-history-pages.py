"""Compare all rich fixture events with the rows returned through a real Server.

Seed with seed-released-runtime-history.py and use the same database and namespace.
Run in the SDK's test environment, e.g. python check-released-history-pages.py
--facade v0.8.0=http://127.0.0.1:20200 --max-page-p95-ms 1000.
"""

import argparse
import asyncio
import json
import math
import os
import time

import asyncpg
import httpx


SESSION = "local-heavy-C"
BASE_REQUEST = {
    "AgentId": "local-heavy-history",
    "SessionId": SESSION,
    "HistoryView": "items-v1",
    "IncludeToolEvents": True,
    "Limit": 50,
}


async def read_fixture():
    connection = await asyncpg.connect(os.environ["KSADK_TEST_POSTGRES_DSN"])
    try:
        rows = await connection.fetch(
            """
            SELECT seq_id, id, invocation_id, author, event_type, timestamp, content_json, metadata_json
            FROM ksadk_events WHERE namespace=$1 AND session_id=$2 ORDER BY seq_id
        """,
            os.environ["KSADK_HISTORY_FIXTURE_NAMESPACE"],
            SESSION,
        )
    finally:
        await connection.close()
    if len(rows) != 17_328:
        raise ValueError("Seed local-heavy-C before running the release comparison")
    if (
        sum(
            len(row["content_json"].encode()) + len(row["metadata_json"].encode())
            for row in rows
        )
        <= 16 * 1024**2
    ):
        raise ValueError(
            "The rich fixture must exceed the former 16 MiB projection budget"
        )
    return [
        {
            "SeqId": row["seq_id"],
            "EventId": row["id"],
            "InvocationId": row["invocation_id"],
            "Author": row["author"],
            "EventType": row["event_type"],
            "Timestamp": row["timestamp"],
            "Content": json.loads(row["content_json"]),
            "Metadata": json.loads(row["metadata_json"]),
        }
        for row in rows
    ]


async def read_page(client, options):
    start = time.perf_counter()
    response = await client.post(
        "/agentengine/api/v1/ListSessionMessages", json={**BASE_REQUEST, **options}
    )
    response.raise_for_status()
    result = response.json()
    elapsed = 1000 * (time.perf_counter() - start)
    if result.get("Code") != 0:
        raise AssertionError((result.get("Code"), result.get("ReasonCode")))
    page = result["Data"]
    if page.get("HistoryView") != "items-v1" or page.get("SessionId") != SESSION:
        raise AssertionError("Expected lossless item history for this Runtime")
    return page, elapsed


def verify_page(page, expected):
    items = page["Items"]
    if not items or len(items) > BASE_REQUEST["Limit"] or len(items) != len(expected):
        raise AssertionError("Unexpected item count")
    for item, row in zip(items, expected, strict=True):
        event = item["Event"]
        if item["ItemId"] != row["EventId"] or item["SeqId"] != row["SeqId"]:
            raise AssertionError(
                f"Incorrect item identity or order at seq {row['SeqId']}"
            )
        for key, value in row.items():
            actual = event.get(key, {} if key == "Metadata" else None)
            if actual != value:
                raise AssertionError(f"Incorrect {key} at seq {row['SeqId']}")


async def verify_source(name, url, rows, max_p95_ms):
    times = []
    end = len(rows)
    cursors = set()
    options = {}
    async with httpx.AsyncClient(
        base_url=url, timeout=30, headers={"X-Ksc-Account-Id": "acct-1"}
    ) as client:
        while end:
            page, elapsed = await read_page(client, options)
            times.append(elapsed)
            if not options:
                epoch, snapshot = page["HistoryEpoch"], page["SnapshotSeqId"]
                if not epoch or snapshot != rows[-1]["SeqId"]:
                    raise AssertionError("Missing or incorrect initial snapshot")
            if (page["HistoryEpoch"], page["SnapshotSeqId"]) != (epoch, snapshot):
                raise AssertionError("Source changed during history traversal")
            start = end - len(page["Items"])
            verify_page(page, rows[start:end])
            if len(times) == 3:
                retry, _ = await read_page(client, options)
                verify_page(retry, rows[start:end])
                if retry.get("NextItemCursor") != page.get("NextItemCursor"):
                    raise AssertionError("Retry moved the continuation boundary")
            end = start
            cursor = page.get("NextItemCursor")
            if bool(end) != bool(page["HasMore"]) or bool(end) != bool(cursor):
                raise AssertionError("Invalid end of history")
            if cursor in cursors:
                raise AssertionError("Repeated continuation")
            cursors.add(cursor)
            options = {
                "ItemCursor": cursor,
                "HistoryEpoch": epoch,
                "SnapshotSeqId": snapshot,
                "CursorSource": "runtime",
            }
        # Resume across the two same-name tool calls and their out-of-order results.
        start = 17180
        options = {
            "AfterSeqId": rows[start - 1]["SeqId"],
            "HistoryEpoch": epoch,
            "CursorSource": "runtime",
        }
        while start < len(rows):
            page, _ = await read_page(client, options)
            stop = start + len(page["Items"])
            verify_page(page, rows[start:stop])
            if page["HistoryEpoch"] != epoch or page["SnapshotSeqId"] != snapshot:
                raise AssertionError("Source changed during catch-up")
            if bool(page["HasMore"]) != (stop < len(rows)):
                raise AssertionError("Invalid end of catch-up")
            options = {
                "ItemCursor": page.get("NextItemCursor"),
                "HistoryEpoch": epoch,
                "SnapshotSeqId": snapshot,
                "CursorSource": "runtime",
            }
            start = stop
    p95 = sorted(times)[math.ceil(0.95 * len(times)) - 1]
    print(
        json.dumps(
            {
                "runtime": name,
                "events": len(rows),
                "pages": len(times),
                "first_page_ms": round(times[0], 1),
                "p95_ms": round(p95, 1),
                "max_ms": round(max(times), 1),
            }
        ),
        flush=True,
    )
    if max_p95_ms is not None and p95 > max_p95_ms:
        raise AssertionError(f"{name} page p95 exceeds {max_p95_ms} ms")


async def main(args):
    rows = await read_fixture()
    for facade in args.facade:
        name, url = facade.split("=", 1)
        await verify_source(name, url, rows, args.max_page_p95_ms)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--facade", action="append", required=True, metavar="TAG=URL")
    parser.add_argument("--max-page-p95-ms", type=float)
    asyncio.run(main(parser.parse_args()))
