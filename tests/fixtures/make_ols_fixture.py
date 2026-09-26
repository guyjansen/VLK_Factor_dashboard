"""Generate reference OLS / Newey-West results with statsmodels for the JS tests.

Run: python tests/fixtures/make_ols_fixture.py
"""

import json
import math
from pathlib import Path

import numpy as np
import statsmodels.api as sm

rng = np.random.default_rng(42)
cases = []
for n, k, ar in ((156, 3, 0.0), (260, 6, 0.3), (60, 2, 0.5)):
    X = rng.normal(size=(n, k)) * np.array([0.02, 8.0, 0.01, 0.005, 0.004, 0.003][:k])
    beta = rng.normal(size=k)
    e = np.zeros(n)
    shocks = rng.normal(scale=0.02, size=n)
    for t in range(n):  # autocorrelated errors so HAC differs from OLS
        e[t] = ar * (e[t - 1] if t else 0.0) + shocks[t]
    y = 0.001 + X @ beta + e
    lags = int(math.floor(4 * (n / 100) ** (2 / 9)))
    design = sm.add_constant(X)
    plain = sm.OLS(y, design).fit()
    hac = sm.OLS(y, design).fit(cov_type="HAC", cov_kwds={"maxlags": lags, "use_correction": True})
    cases.append(
        {
            "y": y.tolist(),
            "cols": X.T.tolist(),
            "lags": lags,
            "coef": plain.params.tolist(),
            "se_ols": plain.bse.tolist(),
            "se_hac": hac.bse.tolist(),
            "r2": plain.rsquared,
            "adj_r2": plain.rsquared_adj,
        }
    )

out = Path(__file__).with_name("ols_fixture.json")
out.write_text(json.dumps({"cases": cases}))
print(f"wrote {out}")
