import os

SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]
INSTALLED_APPS: list[str] = []
DATABASES = {"default": {"ENGINE": "django.db.backends.postgresql", "NAME": "app"}}
