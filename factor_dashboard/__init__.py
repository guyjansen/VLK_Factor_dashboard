"""Data pipeline for the European listed real estate factor dashboard.

The pipeline only uses publicly available sources (Yahoo Finance, the Kenneth
French data library, the ECB, national central banks and FRED). It writes one
data file, ``docs/data/dashboard_data.js``, which the static dashboard in
``docs/`` reads. All factor analytics run in the browser, so the dashboard can
re-estimate exposures for any window, frequency or factor set.
"""

__version__ = "1.0.0"
