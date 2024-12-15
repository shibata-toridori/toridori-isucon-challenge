DB_PORT ?= 33306
DB_HOST ?= 127.0.0.1
DB_USER ?= user
DB_PASSWORD ?= password

.PHONY: init

init: init-env data/dump.sql.bz2 benchmarker/userdata/img

up:
	docker compose up -d

init-env:
	cp .env.example .env

load-initial-data:
	bunzip2 -c data/dump.sql.bz2 | mysql -u$(DB_USER) -p$(DB_PASSWORD) -h$(DB_HOST) -P$(DB_PORT) isuconp

data/dump.sql.bz2:
	cd data && \
	curl -L -O https://github.com/catatsuy/private-isu/releases/download/img/dump.sql.bz2

benchmarker/userdata/img.zip:
	cd benchmarker/userdata && \
	curl -L -O https://github.com/catatsuy/private-isu/releases/download/img/img.zip

benchmarker/userdata/img: benchmarker/userdata/img.zip
	cd benchmarker/userdata && \
	unzip -qq -o img.zip
