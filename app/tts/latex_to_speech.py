import re

GREEK = {
    'alpha': 'alpha', 'beta': 'beta', 'gamma': 'gamma', 'delta': 'delta',
    'epsilon': 'epsilon', 'varepsilon': 'epsilon', 'zeta': 'zeta', 'eta': 'eta',
    'theta': 'theta', 'vartheta': 'theta', 'iota': 'iota', 'kappa': 'kappa',
    'lambda': 'lambda', 'mu': 'mu', 'nu': 'nu', 'xi': 'xi', 'omicron': 'omicron',
    'pi': 'pi', 'varpi': 'pi', 'rho': 'rho', 'varrho': 'rho', 'sigma': 'sigma',
    'varsigma': 'sigma', 'tau': 'tau', 'upsilon': 'upsilon', 'phi': 'phi',
    'varphi': 'phi', 'chi': 'chi', 'psi': 'psi', 'omega': 'omega',
    'Gamma': 'gamma', 'Delta': 'delta', 'Theta': 'theta', 'Lambda': 'lambda',
    'Xi': 'xi', 'Pi': 'pi', 'Sigma': 'sigma', 'Upsilon': 'upsilon',
    'Phi': 'phi', 'Psi': 'psi', 'Omega': 'omega',
}

SIMPLE = {
    'infty': 'infinity', 'pm': 'plus or minus', 'mp': 'minus or plus',
    'leq': 'is less than or equal to', 'le': 'is less than or equal to',
    'geq': 'is greater than or equal to', 'ge': 'is greater than or equal to',
    'neq': 'is not equal to', 'ne': 'is not equal to',
    'approx': 'is approximately equal to', 'equiv': 'is equivalent to',
    'propto': 'is proportional to', 'sim': 'is distributed as',
    'to': 'tends to', 'rightarrow': 'tends to', 'longrightarrow': 'tends to',
    'Rightarrow': 'implies', 'implies': 'implies', 'mapsto': 'maps to',
    'iff': 'if and only if', 'Leftrightarrow': 'if and only if',
    'cdot': 'times', 'times': 'times', 'div': 'divided by',
    'partial': 'partial', 'nabla': 'nabla', 'circ': 'composed with',
    'in': 'is in', 'notin': 'is not in',
    'subseteq': 'is a subset of', 'subset': 'is a subset of',
    'supseteq': 'is a superset of', 'supset': 'is a superset of',
    'cup': 'union', 'cap': 'intersect',
    'emptyset': 'the empty set', 'varnothing': 'the empty set',
    'setminus': 'minus', 'mid': 'given',
    'forall': 'for all', 'exists': 'there exists', 'nexists': 'there does not exist',
    'neg': 'not', 'lnot': 'not', 'land': 'and', 'wedge': 'and',
    'lor': 'or', 'vee': 'or',
    'sin': 'sine', 'cos': 'cos', 'tan': 'tan', 'sec': 'sec',
    'csc': 'cosec', 'cosec': 'cosec', 'cot': 'cot',
    'arcsin': 'arc sine', 'arccos': 'arc cos', 'arctan': 'arc tan',
    'sinh': 'hyperbolic sine', 'cosh': 'cosh', 'tanh': 'hyperbolic tan',
    'ln': 'the natural log of', 'log': 'log', 'lg': 'log',
    'exp': 'the exponential of', 'det': 'the determinant of',
    'tr': 'the trace of', 'gcd': 'the greatest common divisor of',
    'max': 'the maximum of', 'min': 'the minimum of', 'mod': 'mod',
    'bmod': 'mod', 'pmod': 'mod',
    'Re': 'the real part of', 'Im': 'the imaginary part of',
    'arg': 'the argument of', 'deg': 'the degree of',
    'ldots': 'and so on', 'cdots': 'and so on', 'dots': 'and so on',
    'vdots': 'and so on', 'ddots': 'and so on',
    'therefore': 'therefore', 'because': 'because',
    'perp': 'is perpendicular to', 'parallel': 'is parallel to',
    'angle': 'angle', 'triangle': 'triangle', 'degree': 'degrees',
    'prime': 'prime', 'hbar': 'h bar', 'ell': 'l',
    'oplus': 'direct sum', 'otimes': 'tensor product',
    'langle': '', 'rangle': '', 'quad': ' ', 'qquad': ' ',
}

BLACKBOARD = {
    'R': 'the real numbers', 'Z': 'the integers', 'N': 'the natural numbers',
    'C': 'the complex numbers', 'Q': 'the rational numbers',
    'E': 'the expectation', 'P': 'the probability',
}

ROOTS = {'2': 'square', '3': 'cube', '4': 'fourth', '5': 'fifth', '6': 'sixth', 'n': 'nth'}

_BOUND = r'(?:\{([^{}]*)\}|(\\?\w+))'


def _b(match, *groups):
    for g in groups:
        v = match.group(g)
        if v is not None:
            return v
    return ''


def _fixpoint(s, rules):
    prev = None
    while prev != s:
        prev = s
        for pat, rep in rules:
            s = pat.sub(rep, s)
    return s


_NORMALIZE = [
    (re.compile(r'\\left|\\right|\\middle'), ''),
    (re.compile(r'\\[Bb]igg?[lrm]?'), ''),
    (re.compile(r'\\[,;:!]|\\quad|\\qquad'), ' '),
    (re.compile(r'\\(?:text|textrm|textit|textbf|mathrm|mathit|operatorname)\{([^{}]*)\}'), r' \1 '),
    (re.compile(r'\\displaystyle'), ''),
]

_MATRIX = re.compile(r'\\begin\{([pbvBV]?)matrix\}(.*?)\\end\{\1matrix\}', re.DOTALL)

_BOUNDED_OPS = [
    (re.compile(r'\\int\s*_' + _BOUND + r'\s*\^' + _BOUND),
     lambda m: f'the integral from {_b(m, 1, 2)} to {_b(m, 3, 4)} of '),
    (re.compile(r'\\oint\s*_' + _BOUND + r'\s*\^' + _BOUND),
     lambda m: f'the closed integral from {_b(m, 1, 2)} to {_b(m, 3, 4)} of '),
    (re.compile(r'\\sum\s*_' + _BOUND + r'\s*\^' + _BOUND),
     lambda m: f'the sum from {_b(m, 1, 2)} to {_b(m, 3, 4)} of '),
    (re.compile(r'\\prod\s*_' + _BOUND + r'\s*\^' + _BOUND),
     lambda m: f'the product from {_b(m, 1, 2)} to {_b(m, 3, 4)} of '),
    (re.compile(r'\\int\s*_' + _BOUND), lambda m: f'the integral over {_b(m, 1, 2)} of '),
    (re.compile(r'\\sum\s*_' + _BOUND), lambda m: f'the sum over {_b(m, 1, 2)} of '),
    (re.compile(r'\\lim\s*_\{([^{}]*)\}'), lambda m: f'the limit as {m.group(1)} of '),
    (re.compile(r'\\iint'), 'the double integral of '),
    (re.compile(r'\\iiint'), 'the triple integral of '),
    (re.compile(r'\\oint'), 'the closed integral of '),
    (re.compile(r'\\int'), 'the integral of '),
    (re.compile(r'\\sum'), 'the sum of '),
    (re.compile(r'\\prod'), 'the product of '),
    (re.compile(r'\\lim'), 'the limit of '),
]


def _bold(m):
    inner = m.group(1).strip()
    if len(inner) == 1 and inner.islower():
        return f' vector {inner} '
    if len(inner) == 1 and inner.isupper():
        return f' the matrix {inner} '
    return f' bold {inner} '


def _root(m):
    idx = m.group(1)
    word = ROOTS.get(idx)
    return f' the {word} root of {m.group(2)} ' if word else f' the {idx}-th root of {m.group(2)} '


_BRACE_RULES = [
    (re.compile(r'\\binom\{([^{}]*)\}\{([^{}]*)\}'), r' \1 choose \2 '),
    (re.compile(r'\\d?frac\{([^{}]*)\}\{([^{}]*)\}'), r' \1 over \2 '),
    (re.compile(r'\\sqrt\[([^\]]*)\]\{([^{}]*)\}'), _root),
    (re.compile(r'\\sqrt\{([^{}]*)\}'), r' the square root of \1 '),
    (re.compile(r'\\(?:mathbf|boldsymbol|bm|vec|underline)\{([^{}]*)\}'), _bold),
    (re.compile(r'\\hat\{([^{}]*)\}'), r' \1 hat '),
    (re.compile(r'\\(?:bar|overline)\{([^{}]*)\}'), r' \1 bar '),
    (re.compile(r'\\dot\{([^{}]*)\}'), r' \1 dot '),
    (re.compile(r'\\ddot\{([^{}]*)\}'), r' \1 double dot '),
    (re.compile(r'\\tilde\{([^{}]*)\}'), r' \1 tilde '),
    (re.compile(r'\\mathbb\{([A-Z])\}'), lambda m: f' {BLACKBOARD.get(m.group(1), "blackboard " + m.group(1))} '),
    (re.compile(r'\\mathcal\{([^{}]*)\}'), r' script \1 '),
    (re.compile(r'\^(?:\{T\}|T\b)|\^\\top|\^\\intercal'), ' transpose '),
    (re.compile(r'\^\{-1\}'), ' inverse '),
    (re.compile(r'\^(?:\{2\}|2(?!\d))'), ' squared '),
    (re.compile(r'\^(?:\{3\}|3(?!\d))'), ' cubed '),
    (re.compile(r'\^\\circ'), ' degrees '),
    (re.compile(r'\^\\prime|\^\{\\prime\}'), ' prime '),
    (re.compile(r'\^\{([^{}]*)\}'), r' to the power of \1 '),
    (re.compile(r'\^(\\?\w+)'), r' to the power of \1 '),
    (re.compile(r'_\{([^{}]*)\}'), r' sub \1 '),
    (re.compile(r'_(\\?\w+)'), r' sub \1 '),
]

_COMMAND = re.compile(r'\\([A-Za-z]+)')

_SYMBOLS = [
    (re.compile(r'\\\|([^|]+)\\\|'), r' the norm of \1 '),
    (re.compile(r'\|([^|]+)\|'), r' the modulus of \1 '),
    (re.compile(r'(\w|\))\s*!'), r'\1 factorial '),
    (re.compile(r'='), ' equals '),
    (re.compile(r'\+'), ' plus '),
    (re.compile(r'-'), ' minus '),
    (re.compile(r'<'), ' is less than '),
    (re.compile(r'>'), ' is greater than '),
    (re.compile(r'/'), ' over '),
    (re.compile(r'\*'), ' times '),
    (re.compile(r'\bd([xyztuv])\b'), r'd \1'),
]

# Derivative primes: f'(2) must be "f prime of 2", not "f 2". Kokoro says
# nothing at all for a bare apostrophe, so this has to happen in text.
_PRIME = re.compile(r"([A-Za-z])'''")
_PRIME2 = re.compile(r"([A-Za-z])''")
_PRIME1 = re.compile(r"([A-Za-z])'(?![a-z])")
_FUNC_APP = re.compile(r'\b([fgh])((?:\s+(?:double |triple )?prime)?)\s*\(')
_MATH_SEGMENT = re.compile(r'\$\$(.+?)\$\$|\$(.+?)\$|\\\[(.+?)\\\]|\\\((.+?)\\\)', re.DOTALL)


def _speak_matrix(m):
    kind = m.group(1)
    body = m.group(2).strip()
    rows = [r.strip() for r in re.split(r'\\\\', body) if r.strip()]
    cells = [[c.strip() for c in r.split('&')] for r in rows]
    nrows, ncols = len(cells), max(len(r) for r in cells)
    spoken_rows = ', then row '.join(
        f'{i + 1}: ' + ', '.join(r) for i, r in enumerate(cells)
    )
    prefix = 'the determinant of the' if kind in ('v', 'V') else 'the'
    return f' {prefix} {nrows} by {ncols} matrix with row {spoken_rows} '


def _command_word(m):
    name = m.group(1)
    if name in GREEK:
        return f' {GREEK[name]} '
    if name in SIMPLE:
        return f' {SIMPLE[name]} '
    return f' {name} '


def convert_math(s, verbalize_symbols=True):
    for pat, rep in _NORMALIZE:
        s = pat.sub(rep, s)
    s = _MATRIX.sub(_speak_matrix, s)
    for pat, rep in _BOUNDED_OPS:
        s = pat.sub(rep, s)
    s = _fixpoint(s, _BRACE_RULES)
    s = _COMMAND.sub(_command_word, s)
    s = _PRIME.sub(r'\1 triple prime ', s)
    s = _PRIME2.sub(r'\1 double prime ', s)
    s = _PRIME1.sub(r'\1 prime ', s)
    s = _FUNC_APP.sub(r'\1\2 of (', s)
    if verbalize_symbols:
        for pat, rep in _SYMBOLS:
            s = pat.sub(rep, s)
    s = re.sub(r'[{}()\[\]&~]', ' ', s)
    s = re.sub(r'\s+([,.;])', r'\1', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def convert_latex(text):
    def repl(m):
        inner = next(g for g in m.groups() if g is not None)
        return ' ' + convert_math(inner) + ' '

    text = _MATH_SEGMENT.sub(repl, text)
    if '\\' in text or re.search(r'[\^_]\{', text):
        text = convert_math(text, verbalize_symbols=False)
    text = re.sub(r'\s+([,.;:?])', r'\1', text)
    return re.sub(r'\s+', ' ', text).strip()


if __name__ == '__main__':
    import sys
    print(convert_latex(' '.join(sys.argv[1:])))
