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
import uuid

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
    if page.get("HistoryView") != "items-v1" or page.get("SessionId") != options.get(
        "SessionId", SESSION
    ):
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


async def verify_appends(name, url):
    from ksadk.sessions.postgres_service import PostgresSessionService

    namespace = os.environ["KSADK_HISTORY_FIXTURE_NAMESPACE"]
    dsn = os.environ["KSADK_TEST_POSTGRES_DSN"]
    session_id = "release-resume-" + uuid.uuid4().hex
    service = PostgresSessionService(dsn=dsn, namespace=namespace)
    connection = await asyncpg.connect(dsn)

    async def append(start, stop):
        await connection.execute(
            """
            INSERT INTO ksadk_events
                (namespace,session_id,id,author,event_type,content_json,timestamp,seq_id,invocation_id)
            SELECT $1,$2,$2||'-'||n,'assistant','assistant_message',
                   jsonb_build_object('parts',jsonb_build_array(jsonb_build_object('text','marker-'||n))),
                   n,n,'one-call' FROM generate_series($3::int,$4::int) n
        """,
            namespace,
            session_id,
            start,
            stop,
        )

    def verify(page, start, stop, snapshot):
        items = page["Items"]
        if page["SnapshotSeqId"] != snapshot or [
            item["SeqId"] for item in items
        ] != list(range(start, stop)):
            raise AssertionError((name, "reconnect page", start, stop))
        if [item["Event"]["Content"]["parts"][0]["text"] for item in items] != [
            "marker-" + str(n) for n in range(start, stop)
        ]:
            raise AssertionError((name, "reconnect payload"))

    auth = {"X-Ksc-Account-Id": "acct-1"}
    try:
        await service.create_session("local-heavy-history", "user", session_id)
        await append(1, 150)
        async with httpx.AsyncClient(base_url=url, headers=auth, timeout=30) as client:
            first, _ = await read_page(client, {"SessionId": session_id})
            verify(first, 101, 151, 150)
        await append(151, 315)
        state = {
            "SessionId": session_id,
            "HistoryEpoch": first["HistoryEpoch"],
            "CursorSource": "runtime",
        }
        async with httpx.AsyncClient(base_url=url, headers=auth, timeout=30) as client:
            cursor = first["NextItemCursor"]
            for start in (51, 1):
                older, _ = await read_page(
                    client, {**state, "SnapshotSeqId": 150, "ItemCursor": cursor}
                )
                verify(older, start, start + 50, 150)
                cursor = older.get("NextItemCursor")
            if cursor or older["HasMore"]:
                raise AssertionError((name, "old snapshot did not terminate"))
            options = {"AfterSeqId": 150}
            for start in range(151, 316, 50):
                page, _ = await read_page(client, {**state, **options})
                verify(page, start, min(start + 50, 316), 315)
                if page["HistoryEpoch"] != first["HistoryEpoch"]:
                    raise AssertionError((name, "epoch changed on append"))
                options = {
                    "SnapshotSeqId": 315,
                    "ItemCursor": page.get("NextItemCursor"),
                }
            if options["ItemCursor"] or page["HasMore"]:
                raise AssertionError((name, "catch-up did not terminate"))
    finally:
        try:
            await service.delete_session(session_id)
        finally:
            await connection.close()
            await service.aclose()


async def main(args):
    rows = await read_fixture()
    for facade in args.facade:
        name, url = facade.split("=", 1)
        await verify_source(name, url, rows, args.max_page_p95_ms)
        if args.verify_appends:
            await verify_appends(name, url)
            print(
                json.dumps(
                    {
                        "runtime": name,
                        "appended_during_disconnect": 165,
                        "resumed": True,
                    }
                ),
                flush=True,
            )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--facade", action="append", required=True, metavar="TAG=URL")
    parser.add_argument("--max-page-p95-ms", type=float)
    parser.add_argument(
        "--verify-appends",
        action="store_true",
        help="Create and remove a dedicated reconnect fixture per target",
    )
    asyncio.run(main(parser.parse_args()))
