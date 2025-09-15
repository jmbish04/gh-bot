# --- inside WorkerTester.__init__ ---
self.session = requests.Session()
self.session.headers.update(DEFAULT_HEADERS)