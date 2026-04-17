"""Security regressions for bootstrapper/provision.py (M6).

Pre-M6 the Jinja2 environment was un-sandboxed and project_description
landed in the template as a plain string. A malicious caller could have
written ``{{ ... }}`` payloads into the description that would execute
at render time. Since M6 the renderer uses
:class:`jinja2.sandbox.SandboxedEnvironment` and a typed
:class:`bootstrapper.provision.TemplateContext`; the same payloads now
land literally in the rendered document.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from bootstrapper.provision import TemplateContext, render_claude_md


class TestSSTIPayloadsAreRenderedLiterally:
    """Any Jinja-looking input in project_description must NOT execute."""

    @pytest.mark.parametrize(
        "payload",
        [
            # Attribute chains the sandbox blocks.
            "{{ ''.__class__.__mro__ }}",
            "{{ config.__class__ }}",
            # Classic RCE attempts.
            "{{ self._TemplateReference__context.environment.__class__ }}",
            "{{ ''.__class__.__subclasses__() }}",
            # Statement smuggling.
            "{% for x in range(3) %}{{ x }}{% endfor %}",
            "{% set boom = 1 %}{{ boom }}",
            # Filter abuse.
            "{{ 'pwd'|attr('__class__') }}",
        ],
    )
    def test_payload_survives_render_as_plain_text(self, payload: str) -> None:
        """The payload is passed as project_description and should appear
        verbatim in the rendered CLAUDE.md — *not* as the output of the
        expression inside."""
        out = render_claude_md("base", "Demo", payload)
        assert payload in out, (
            f"SSTI payload was evaluated or stripped — expected literal:\n"
            f"{payload!r}\n got:\n{out[:400]!r}"
        )
        # Double-check by looking for signs the expression was evaluated:
        # the classic ``.__class__`` evaluation would surface as a
        # Python repr like ``<class 'str'>`` — which must NOT appear.
        assert "<class '" not in out

    def test_sandbox_is_actually_used(self) -> None:
        """Sanity check that :func:`render_claude_md` uses a
        :class:`SandboxedEnvironment`. A regression that falls back to
        the vanilla :class:`jinja2.Environment` would defeat the SSTI
        guard.

        We verify by patching the Jinja2 sandbox to record every
        template compile; a clean render_claude_md call must go
        through it at least once.
        """
        from jinja2.sandbox import SandboxedEnvironment

        import bootstrapper.provision as module

        compile_count = 0
        original_compile = SandboxedEnvironment._parse

        def tracked(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            nonlocal compile_count
            compile_count += 1
            return original_compile(self, *args, **kwargs)

        SandboxedEnvironment._parse = tracked  # type: ignore[assignment]
        try:
            module.render_claude_md("base", "Demo", "{{ 1 + 1 }}")
        finally:
            SandboxedEnvironment._parse = original_compile  # type: ignore[assignment]

        assert compile_count >= 1, "render_claude_md did not use SandboxedEnvironment"


class TestTemplateContextValidation:
    def test_project_name_is_required(self) -> None:
        with pytest.raises(ValidationError):
            TemplateContext(project_name="", project_description="desc")

    def test_description_length_cap(self) -> None:
        with pytest.raises(ValidationError):
            TemplateContext(
                project_name="ok",
                project_description="x" * 10_001,
            )

    def test_slug_is_derived_from_name(self) -> None:
        ctx = TemplateContext(project_name="My Cool Project")
        data = ctx.dump_for_template()
        assert data["project_slug"] == "my_cool_project"
