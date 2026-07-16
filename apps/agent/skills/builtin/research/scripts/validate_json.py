#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Validate research deep-mode result JSON against fields.yaml.

Supports:
  - flat: fields: [{ name, category, required? }, ...]
  - nested: field_categories: [{ category, fields: [{ name, required? }] }]
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore

# Common nested category key aliases (optional structural skip when walking JSON)
DEFAULT_NESTED_CATEGORY_KEYS = {
    "basic_info",
    "基本信息",
    "technical_features",
    "technical_characteristics",
    "技术特性",
    "performance_metrics",
    "performance",
    "性能指标",
    "milestone_significance",
    "milestones",
    "里程碑意义",
    "business_info",
    "commercial_info",
    "商业信息",
    "competition_ecosystem",
    "competition",
    "竞争与生态",
    "history",
    "历史沿革",
    "market_positioning",
    "market",
    "市场定位",
    "行情快照",
    "驱动因素",
    "市场解读",
    "影响评估",
    "风险与机会",
    "期权与机构流",
    "期货与次日",
    "时效性",
    "market_snapshot",
    "drivers",
    "interpretation",
    "impact",
    "risks_opportunities",
    "options_flow",
    "futures_next",
    "timeliness",
}

_SKIP_KEYS = {
    "_source_file",
    "uncertain",
    "item_name",
    "item_id",
    "sources",
    "companies_detail",
    "noise_filter_note",
    "top_ah_gainers_filtered",
    "top_ah_losers_filtered",
    "bmo_context_note",
    "non_earnings_ah_note",
}


def _load_yaml(path: Path):
    text = path.read_text(encoding="utf-8")
    if yaml is not None:
        return yaml.safe_load(text)
    return _minimal_fields_parse(text)


def _minimal_fields_parse(text: str):
    """Fallback when PyYAML is unavailable: parse flat `fields:` list only."""
    fields: list[dict] = []
    current: dict | None = None
    in_fields = False
    for line in text.splitlines():
        if line.startswith("field_categories:"):
            in_fields = False
            break
        if line.startswith("fields:"):
            in_fields = True
            continue
        if not in_fields:
            continue
        if line.startswith("uncertain:") or line.startswith("field_usage_notes:"):
            break
        if line.startswith("  - name:"):
            if current:
                fields.append(current)
            current = {"name": line.split(":", 1)[1].strip().strip("\"'")}
            continue
        if current is None:
            continue
        for key in ("category", "description", "detail_level", "required"):
            prefix = f"    {key}:"
            if line.startswith(prefix):
                raw = line[len(prefix) :].strip().strip("\"'")
                if key == "required":
                    current[key] = raw.lower() in ("true", "yes", "1")
                else:
                    current[key] = raw
    if current:
        fields.append(current)
    return {"fields": fields}


def load_fields_yaml(fields_path: Path):
    data = _load_yaml(fields_path) or {}
    items: list[tuple[str, str, bool]] = []

    flat = data.get("fields")
    if isinstance(flat, list) and flat:
        for field in flat:
            if not isinstance(field, dict) or "name" not in field:
                continue
            name = str(field["name"])
            cat = str(field.get("category") or "其他")
            required = bool(field.get("required", False))
            items.append((name, cat, required))
    else:
        for category in data.get("field_categories") or []:
            if not isinstance(category, dict):
                continue
            cat_name = str(category.get("category") or "其他")
            for field in category.get("fields") or []:
                if not isinstance(field, dict) or "name" not in field:
                    continue
                name = str(field["name"])
                required = bool(field.get("required", False))
                items.append((name, cat_name, required))

    all_fields = {name for name, _, _ in items}
    required_fields = {name for name, _, required in items if required}
    field_categories = {name: category for name, category, _ in items}
    nested_keys = set(DEFAULT_NESTED_CATEGORY_KEYS)
    nested_keys.update(field_categories.values())
    return all_fields, required_fields, field_categories, nested_keys


def extract_json_fields(data, nested_keys: set[str]):
    fields: set[str] = set()
    stack: list[tuple[object, bool]] = [(data, True)]
    while stack:
        obj, is_category_level = stack.pop()
        if isinstance(obj, dict):
            for k, v in obj.items():
                if k in _SKIP_KEYS:
                    continue
                if is_category_level and k in nested_keys and isinstance(v, dict):
                    stack.append((v, True))
                    continue
                fields.add(k)
                if isinstance(v, dict):
                    stack.append((v, False))
                elif isinstance(v, list):
                    for item in v:
                        if isinstance(item, dict):
                            stack.append((item, False))
        elif isinstance(obj, list):
            for item in obj:
                if isinstance(item, dict):
                    stack.append((item, is_category_level))
    return fields


def present_field_keys(data) -> set[str]:
    """Keys present at top level or one category nest (for required check with [不确定])."""
    keys: set[str] = set()
    if not isinstance(data, dict):
        return keys
    for k, v in data.items():
        if k in _SKIP_KEYS:
            continue
        if isinstance(v, dict) and k in DEFAULT_NESTED_CATEGORY_KEYS:
            keys.update(v.keys())
        else:
            keys.add(k)
    return keys


def validate_json(json_path: Path, all_fields, required_fields, field_categories, nested_keys):
    with json_path.open(encoding="utf-8") as f:
        data = json.load(f)
    json_fields = extract_json_fields(data, nested_keys)
    # Also count top-level keys that exist even if value is uncertain string
    present = present_field_keys(data) | json_fields
    covered = all_fields & present
    missing = all_fields - present
    extra = present - all_fields - _SKIP_KEYS
    missing_required = missing & required_fields
    missing_by_category: dict[str, list[str]] = defaultdict(list)
    for field in missing:
        missing_by_category[field_categories.get(field, "未知")].append(field)
    return {
        "file": json_path.name,
        "total_defined": len(all_fields),
        "covered": len(covered),
        "missing": len(missing),
        "extra": len(extra),
        "coverage_rate": len(covered) / len(all_fields) * 100 if all_fields else 100.0,
        "missing_required": sorted(missing_required),
        "missing_optional": sorted(missing - required_fields),
        "missing_by_category": {k: sorted(v) for k, v in missing_by_category.items()},
        "extra_fields": sorted(extra),
        "valid": len(missing_required) == 0,
    }


def print_result(result, verbose=True):
    status = "通过" if result["valid"] else "失败"
    line = "=" * 60
    print(f"\n{line}")
    print(f"[{status}] {result['file']}")
    print(line)
    print(f"覆盖率: {result['coverage_rate']:.1f}% ({result['covered']}/{result['total_defined']})")
    if result["missing_required"]:
        print(f"\n[错误] 缺少必填字段 ({len(result['missing_required'])}):")
        print("\n".join(f"  - {f}" for f in result["missing_required"]))
    if verbose and result["missing_optional"]:
        missing_required = set(result["missing_required"])
        print(f"\n[警告] 缺少可选字段 ({len(result['missing_optional'])}):")
        for cat in sorted(result["missing_by_category"]):
            optional = [f for f in result["missing_by_category"][cat] if f not in missing_required]
            if optional:
                print(f"  [{cat}]: {', '.join(optional)}")
    if verbose and result["extra_fields"]:
        extra = result["extra_fields"]
        print(f"\n[信息] 额外字段 ({len(extra)}):")
        print(f"  {', '.join(extra[:10])}")
        if len(extra) > 10:
            print(f"  ... 还有 {len(extra) - 10} 个")


def main():
    parser = argparse.ArgumentParser(description="验证 research deep-mode JSON 是否覆盖 fields.yaml")
    parser.add_argument("--fields", "-f", type=str, default="fields.yaml", help="fields.yaml 路径")
    parser.add_argument("--json", "-j", type=str, nargs="*", help="JSON 文件路径")
    parser.add_argument("--dir", "-d", type=str, default="results", help="JSON 目录")
    parser.add_argument("--quiet", "-q", action="store_true", help="仅摘要")
    args = parser.parse_args()

    fields_path = Path(args.fields)
    if not fields_path.exists():
        for p in (Path.cwd() / "fields.yaml", Path.cwd().parent / "fields.yaml"):
            if p.exists():
                fields_path = p
                break
    if not fields_path.exists():
        print(f"[错误] 找不到 fields.yaml: {fields_path}")
        sys.exit(1)

    print(f"字段定义文件: {fields_path}")
    all_fields, required_fields, field_categories, nested_keys = load_fields_yaml(fields_path)
    if not all_fields:
        print("[错误] fields.yaml 未解析到任何字段")
        sys.exit(1)
    print(
        f"总字段数: {len(all_fields)} "
        f"(必填: {len(required_fields)}, 可选: {len(all_fields) - len(required_fields)})"
    )

    json_files = (
        [Path(p) for p in args.json]
        if args.json
        else sorted(Path(args.dir).glob("*.json"))
        if Path(args.dir).exists()
        else []
    )
    if not json_files:
        print("[警告] 未找到 JSON 文件")
        sys.exit(0)

    results = []
    for json_path in json_files:
        if not json_path.exists():
            print(f"[警告] 文件不存在: {json_path}")
            continue
        result = validate_json(
            json_path, all_fields, required_fields, field_categories, nested_keys
        )
        results.append(result)
        print_result(result, verbose=not args.quiet)

    line = "=" * 60
    print(f"\n{line}")
    print("汇总")
    print(line)
    passed = sum(1 for r in results if r["valid"])
    avg_coverage = sum(r["coverage_rate"] for r in results) / len(results) if results else 0
    print(f"验证通过: {passed}/{len(results)}")
    print(f"平均覆盖率: {avg_coverage:.1f}%")
    if passed < len(results):
        sys.exit(1)


if __name__ == "__main__":
    main()
