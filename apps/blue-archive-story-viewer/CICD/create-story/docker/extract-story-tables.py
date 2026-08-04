#!/usr/bin/env python3
"""Export only the ExcelDB tables needed by the story pipeline."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from ba_downloader.application.config import AppSettings
from ba_downloader.bootstrap.container import build_sync_runtime_services
from ba_downloader.bootstrap.region_profiles import (
    DEFAULT_REGION_SERVICE_PROFILE_REGISTRY,
)
from ba_downloader.infrastructure.extraction.table.extractor import TableExtractor
from ba_downloader.infrastructure.logging.console_logger import ConsoleLogger
from ba_downloader.infrastructure.storage import TableDatabase


DEFAULT_TABLES = (
    "ScenarioScriptDBSchema",
    "EventContentScenarioDBSchema",
    "EventContentSeasonDBSchema",
    "LocalizeDBSchema",
    "LocalizeEtcDBSchema",
    "ScenarioCharacterNameDBSchema",
)
SCHEMA_DIRECTORIES = ("FlatBufferData", "MemoryPackData")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Reuse Blue-Archive-Asset-Downloader internals to export only the "
            "ExcelDB tables required by the story workflow."
        )
    )
    parser.add_argument("--region", choices=("gl", "jp"), default="gl")
    parser.add_argument("--raw-dir", required=True)
    parser.add_argument("--extract-dir", required=True)
    parser.add_argument("--temp-dir", required=True)
    parser.add_argument("--proxy", default="")
    parser.add_argument("--max-retries", type=int, default=5)
    parser.add_argument(
        "--table",
        action="append",
        dest="tables",
        help="database table to export; repeat to override the default table set",
    )
    return parser.parse_args()


def build_context(args: argparse.Namespace):
    service_profile = DEFAULT_REGION_SERVICE_PROFILE_REGISTRY.resolve(args.region)
    settings = AppSettings(
        region=args.region,
        threads=1,
        raw_dir=str(Path(args.raw_dir).resolve()),
        extract_dir=str(Path(args.extract_dir).resolve()),
        temp_dir=str(Path(args.temp_dir).resolve()),
        resource_type=("table",),
        proxy_url=args.proxy,
        max_retries=args.max_retries,
    )
    return (
        settings.to_runtime_context(service_profile.settings_policy),
        service_profile,
    )


def schemas_ready(extract_dir: Path) -> bool:
    return all(
        (extract_dir / directory / "__init__.py").is_file()
        and (extract_dir / directory / "_registry.py").is_file()
        for directory in SCHEMA_DIRECTORIES
    )


def ensure_schemas(context) -> None:
    extract_dir = Path(context.extract_dir)
    if schemas_ready(extract_dir):
        print(f"Reusing generated schemas from {extract_dir}")
        return

    print(
        f"Generating {context.region.upper()} table schemas "
        "from the cached runtime package...",
        flush=True,
    )
    services = build_sync_runtime_services(context)
    try:
        services.schema_preparation.prepare(context)
    finally:
        services.http_client.close()

    if not schemas_ready(extract_dir):
        raise RuntimeError(
            f"Schema preparation did not create the expected files in {extract_dir}"
        )


def write_table_atomic(
    output_dir: Path,
    table_name: str,
    table,
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{table_name}.json"
    temporary_path = output_path.with_suffix(".json.tmp")
    try:
        with temporary_path.open("w", encoding="utf8") as file_handle:
            json.dump(
                TableDatabase.convert_to_list_dict(table),
                file_handle,
                indent=4,
                ensure_ascii=False,
            )
            file_handle.write("\n")
        os.replace(temporary_path, output_path)
    finally:
        temporary_path.unlink(missing_ok=True)
    return output_path


def main() -> int:
    args = parse_args()
    context, service_profile = build_context(args)
    database_path = Path(context.raw_dir) / "Table" / "ExcelDB.db"
    if not database_path.is_file():
        raise FileNotFoundError(
            f"{database_path} is missing; run the focused ExcelDB download first"
        )

    ensure_schemas(context)
    logger = ConsoleLogger()
    table_profile = service_profile.table_profile_factory(context)
    extractor = TableExtractor.from_context(
        context,
        logger=logger,
        table_profile=table_profile,
    )
    output_dir = Path(context.extract_dir) / "Table" / "ExcelDB"
    tables = tuple(dict.fromkeys(args.tables or DEFAULT_TABLES))

    print(f"Reading {database_path}", flush=True)
    print(
        f"Exporting {len(tables)} story tables to {output_dir}",
        flush=True,
    )
    for index, table_name in enumerate(tables, start=1):
        db_tables = extractor.process_db_file(
            str(database_path),
            table_name=table_name,
        )
        if len(db_tables) != 1:
            raise RuntimeError(
                f"Expected one table for {table_name}, got {len(db_tables)}"
            )
        output_path = write_table_atomic(output_dir, table_name, db_tables[0])
        print(
            f"[{index}/{len(tables)}] {table_name}: "
            f"{len(db_tables[0].data)} rows, {output_path.stat().st_size} bytes",
            flush=True,
        )

    print("Focused story table extraction complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
