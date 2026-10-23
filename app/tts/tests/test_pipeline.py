import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from latex_to_speech import convert_latex, convert_math
from lexicon import MISAKI_CHARSET, compile_lexicon, ipa_to_misaki

LEXICON = Path(__file__).parent.parent / 'maths_lexicon.json'


class TestLatexToSpeech:
    def test_fraction(self):
        assert convert_math(r'\frac{a}{b}') == 'a over b'

    def test_nested_fraction(self):
        out = convert_math(r'\frac{1}{\frac{a}{b}}')
        assert out == '1 over a over b'

    def test_power_and_subscript(self):
        out = convert_latex(r'$x^2 + x_n$')
        assert 'x squared' in out
        assert 'x sub n' in out
        assert 'plus' in out

    def test_power_with_braces_inside_frac(self):
        out = convert_math(r'\frac{e^{x}}{2}')
        assert out == 'e to the power of x over 2'

    def test_sqrt(self):
        assert convert_math(r'\sqrt{x}') == 'the square root of x'
        assert convert_math(r'\sqrt[3]{x}') == 'the cube root of x'
        assert convert_math(r'\sqrt[n]{x}') == 'the nth root of x'

    def test_greek(self):
        out = convert_latex(r'$\alpha + \beta = \lambda$')
        assert out == 'alpha plus beta equals lambda'

    def test_bounded_integral(self):
        out = convert_latex(r'$\int_0^\infty e^{-x} dx$')
        assert 'the integral from 0 to infinity of' in out

    def test_bare_latex_no_dollars(self):
        out = convert_latex(r'\int_0^\infty')
        assert 'the integral from 0 to infinity of' in out

    def test_sum_with_braced_bounds(self):
        out = convert_latex(r'$\sum_{n=1}^{\infty} \frac{1}{n^2}$')
        assert 'the sum from n equals 1 to infinity of' in out
        assert '1 over n squared' in out

    def test_limit(self):
        out = convert_latex(r'$\lim_{x \to 0} \frac{\sin x}{x}$')
        assert 'the limit as x tends to 0 of' in out
        assert 'sine x over x' in out

    def test_matrix(self):
        out = convert_latex(r'$\begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}$')
        assert 'the 2 by 2 matrix' in out
        assert 'row 1: 1, 2' in out
        assert 'row 2: 3, 4' in out

    def test_vmatrix_is_determinant(self):
        out = convert_latex(r'$\begin{vmatrix} a & b \\ c & d \end{vmatrix}$')
        assert out.startswith('the determinant of the 2 by 2 matrix')

    def test_eigen_equation(self):
        out = convert_latex(r'$\mathbf{A}\mathbf{v} = \lambda \mathbf{v}$')
        assert 'the matrix A' in out
        assert 'vector v' in out
        assert 'equals lambda' in out

    def test_inverse_and_transpose(self):
        assert 'A inverse' in convert_math(r'A^{-1}')
        assert 'A transpose' in convert_math(r'A^T')

    def test_set_notation(self):
        out = convert_latex(r'$x \in \mathbb{R} \cap \mathbb{Z}$')
        assert 'x is in the real numbers intersect the integers' == out

    def test_operators(self):
        out = convert_latex(r'$a \leq b \neq c \approx d$')
        assert 'is less than or equal to' in out
        assert 'is not equal to' in out
        assert 'is approximately equal to' in out

    def test_prose_untouched(self):
        out = convert_latex('A well-known fact! See $x^2$ now.')
        assert 'well-known fact!' in out
        assert 'x squared' in out


class TestLexicon:
    def test_compiles_clean(self):
        compiled, bad = compile_lexicon(LEXICON)
        assert bad == []
        assert len(compiled) > 150

    def test_charset_valid(self):
        compiled, _ = compile_lexicon(LEXICON)
        for word, ps in compiled.items():
            assert set(ps) <= MISAKI_CHARSET, f'{word}: {ps}'

    def test_stress_before_vowel(self):
        assert ipa_to_misaki('ˈmeɪtrɪks') == 'mˈAtɹɪks'
        assert ipa_to_misaki('ˈskeɪlə') == 'skˈAlə'
        assert ipa_to_misaki('ˈkəʊʃi') == 'kˈQʃi'

    def test_affricates_and_trap(self):
        assert ipa_to_misaki('ləˈɡrændʒiən') == 'ləɡɹˈanʤiən'


class TestPhonemes:
    @pytest.fixture(scope='class')
    def g2p(self):
        kokoro = pytest.importorskip('kokoro')
        pipeline = kokoro.KPipeline(lang_code='b', model=False, repo_id='hexgrad/Kokoro-82M')
        from lexicon import apply_lexicon
        apply_lexicon(pipeline, LEXICON)
        return pipeline

    def phonemes(self, g2p, text):
        return ' '.join(r.phonemes for r in g2p(text))

    def test_eigenvalues(self, g2p):
        assert 'ˈIɡənvˌaljuːz' in self.phonemes(g2p, 'the eigenvalues of a matrix')

    def test_lagrangian(self, g2p):
        assert 'ləɡɹˈanʤiən' in self.phonemes(g2p, 'the Lagrangian of the system')

    def test_cauchy(self, g2p):
        assert 'kˈQʃi' in self.phonemes(g2p, "Cauchy's integral formula")

    def test_matrices(self, g2p):
        assert 'mˈAtɹɪsiːz' in self.phonemes(g2p, 'two matrices commute')

    def test_euler(self, g2p):
        assert 'ˈYlə' in self.phonemes(g2p, "Euler's identity")

    def test_full_pipeline_integral(self, g2p):
        spoken = convert_latex(r'The value of $\int_0^\infty e^{-x} dx$ is one.')
        ps = self.phonemes(g2p, spoken)
        assert 'ˈɪntɪɡɹ' in ps
        assert 'ɪnfˈɪnɪti' in ps
