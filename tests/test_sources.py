"""Parsers for each public source, checked against sample payloads."""

from __future__ import annotations

import io
import zipfile

import pandas as pd
import pytest

from factor_dashboard.sources import central_banks as cb
from factor_dashboard.sources import french, fred, stooq

ECB_CSV = """KEY,FREQ,REF_AREA,CURRENCY,PROVIDER_FM,INSTRUMENT_FM,PROVIDER_FM_ID,DATA_TYPE_FM,TIME_PERIOD,OBS_VALUE,OBS_STATUS,TITLE
YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y,B,U2,EUR,4F,G_N_A,SV_C_YM,SR_10Y,2026-09-01,2.6543,A,"Yield curve spot rate, 10-year maturity"
YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y,B,U2,EUR,4F,G_N_A,SV_C_YM,SR_10Y,2026-09-02,2.6711,A,"Yield curve spot rate, 10-year maturity"
"""

BOE_CSV = """DATE,IUDMNZC
02 Jan 2019,1.2461
03 Jan 2019,1.2072
"""

SNB_CSV = '''"CubeId";"rendoblid"
"PublishingDate";"2026-09-25 14:30"

"Date";"D0";"Value"
"2019-01-03";"1J";"-0.7"
"2019-01-03";"10J";"-0.02"
"2019-01-04";"10J";"0.01"
'''

NORGES_CSV = """DATAFLOW,FREQ,TENOR,INSTRUMENT_TYPE,TIME_PERIOD,OBS_VALUE
NB:GOVT_GENERIC_RATES(1.0),B,10Y,GBON,2019-01-02,1.73
NB:GOVT_GENERIC_RATES(1.0),B,10Y,GBON,2019-01-03,1.70
"""

NORGES_SEMICOLON = """FREQ;Frequency;TENOR;Tenor;INSTRUMENT_TYPE;TIME_PERIOD;OBS_VALUE
B;Business;10Y;10 years;GBON;2019-01-02;1,73
B;Business;10Y;10 years;GBON;2019-01-03;1,70
"""

FRED_CSV = """observation_date,BAMLHE00EHYIOAS
2019-01-01,.
2019-01-02,5.12
2019-01-03,5.20
"""

FRENCH_5F = """This file was created using the 202607 Bloomberg database.
The Tbill return is the simple daily rate.

,Mkt-RF,SMB,HML,RMW,CMA,RF
19900702,   0.61,  -0.05,   0.16,  -0.12,   0.07,   0.03
19900703,   0.04,   0.21,  -0.13,   0.00,  -0.07,   0.03

 Annual Factors: January-December
,Mkt-RF,SMB,HML,RMW,CMA,RF
1991,   1.00,  2.00,   3.00,  4.00,   5.00,   6.00
"""

FRENCH_MOM = """This file was created using the 202607 Bloomberg database.

,WML
19900703,   0.29
19900704,  -99.99
"""


def test_ecb():
    s = cb.parse_ecb_csv(ECB_CSV)
    assert list(s.index.strftime("%Y-%m-%d")) == ["2026-09-01", "2026-09-02"]
    assert s.iloc[-1] == pytest.approx(2.6711)


def test_boe():
    s = cb.parse_boe_csv(BOE_CSV, "IUDMNZC")
    assert s.index[0] == pd.Timestamp("2019-01-02")
    assert s.iloc[1] == pytest.approx(1.2072)
    with pytest.raises(ValueError):
        cb.parse_boe_csv("<html><body>blocked</body></html>", "IUDMNZC")


def test_riksbank():
    s = cb.parse_riksbank_json([{"date": "2019-01-02", "value": 0.46}, {"date": "2019-01-03", "value": 0.44}])
    assert s.iloc[0] == pytest.approx(0.46)
    with pytest.raises(ValueError):
        cb.parse_riksbank_json([])


def test_snb_filters_maturity():
    s = cb.parse_snb_csv(SNB_CSV, "10J")
    assert len(s) == 2
    assert s.iloc[0] == pytest.approx(-0.02)


@pytest.mark.parametrize("payload", [NORGES_CSV, NORGES_SEMICOLON])
def test_norges(payload):
    s = cb.parse_sdmx_csv(payload)
    assert s.iloc[0] == pytest.approx(1.73)
    assert len(s) == 2


def test_fred_skips_missing_marker():
    s = fred.parse_fred_csv(FRED_CSV, "BAMLHE00EHYIOAS")
    assert len(s) == 2
    assert s.iloc[-1] == pytest.approx(5.20)


def test_french_daily_table_only():
    df = french.parse_french_csv(FRENCH_5F)
    assert list(df.columns) == ["MKT_RF", "SMB", "HML", "RMW", "CMA", "RF"]
    assert len(df) == 2  # the annual table is ignored
    assert df.loc["1990-07-02", "SMB"] == pytest.approx(-0.0005)
    mom = french.parse_french_csv(FRENCH_MOM)
    assert list(mom.columns) == ["WML"]
    assert pd.isna(mom.loc["1990-07-04", "WML"])  # -99.99 marks missing data


def test_french_zip_roundtrip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Europe_5_Factors_Daily.csv", FRENCH_5F)
    text = french._read_zip_csv(buf.getvalue())
    assert "Mkt-RF" in text


def test_stooq():
    s = stooq.parse_stooq_csv("Date,Open,High,Low,Close\n2019-01-02,0.24,0.25,0.18,0.18\n")
    assert s.iloc[0] == pytest.approx(0.18)
    with pytest.raises(ValueError):
        stooq.parse_stooq_csv("No data")


SNB_MIXED = '''"CubeId";"rendoblid"

"Date";"D0";"Value"
"2019-01-03";"10J0";"-0.02"
"2019-01-03";"10J1";"0.15"
"2019-01-03";"AA";"0.40"
"2019-01-04";"10J0";"0.01"
'''

NORGES_SDMX2 = """STRUCTURE,STRUCTURE_ID,ACTION,FREQ:Frequency,TENOR:Tenor,INSTRUMENT_TYPE:Instrument type,TIME_PERIOD:Time period,OBS_VALUE:Observation value
dataflow,NB:GOVT_GENERIC_RATES(1.0),I,B:Business,10Y:10 years,GBON:Government bonds,2019-01-02,1.73
dataflow,NB:GOVT_GENERIC_RATES(1.0),I,B:Business,10Y:10 years,GBON:Government bonds,2019-01-03,1.70
"""


def test_snb_prefers_confederation_code():
    s = cb.parse_snb_csv(SNB_MIXED, "10J")
    assert list(s.round(2)) == [-0.02, 0.01]


def test_norges_sdmx_csv_2():
    s = cb.parse_sdmx_csv(NORGES_SDMX2)
    assert s.iloc[0] == pytest.approx(1.73)
