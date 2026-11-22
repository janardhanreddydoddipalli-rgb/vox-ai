"""Rubrics: well-formed, one current version per round type, released versions immutable."""

import re

import pytest

from vox_api import rubrics

# Fingerprints of released versions. A failing entry means a released rubric was
# edited: add a new version instead (old evaluations must stay explainable).
RELEASED = {
    "screening-v1": "83a684db2c7e91e4",
    "technical-v1": "b397b7081492dd6a",
    "project-v1": "dfe452492a8681d2",
    "behavioral-v1": "02b639f4562ad60a",
    "managerial-v1": "f4c102af494b3b5b",
}


@pytest.mark.parametrize("version", sorted(rubrics.RUBRICS))
def test_rubric_is_well_formed(version: str) -> None:
    rubric = rubrics.get(version)
    ids = rubric.criterion_ids()
    assert len(ids) == len(set(ids)) >= 2
    assert abs(sum(c.weight for c in rubric.criteria) - 1.0) < 1e-9
    for c in rubric.criteria:
        assert set(c.expectations) == {"junior", "mid", "senior"}
        assert all(text.strip() for text in c.expectations.values())


def test_every_round_type_has_a_current_rubric_and_defaults() -> None:
    assert set(rubrics.CURRENT) == set(rubrics.ROUND_TYPES) == set(rubrics.ROUND_DEFAULTS)
    for round_type, version in rubrics.CURRENT.items():
        assert rubrics.get(version).round_type == round_type


def test_no_criterion_judges_how_someone_sounds() -> None:
    banned = re.compile(r"accent|pitch|speed|pace|fluen|pronunc|voice|tone", re.IGNORECASE)
    for rubric in rubrics.RUBRICS.values():
        for c in rubric.criteria:
            assert not banned.search(" ".join([c.title, c.description, *c.expectations.values()])), c.id


def test_released_versions_are_immutable() -> None:
    actual = {v: rubrics.get(v).fingerprint() for v in RELEASED}
    assert actual == RELEASED


def test_unknown_versions_are_an_error() -> None:
    with pytest.raises(KeyError, match="Unknown rubric version"):
        rubrics.get("technical-v0")
