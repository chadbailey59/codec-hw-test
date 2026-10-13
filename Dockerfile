FROM python:3.13-alpine
WORKDIR /app
COPY server.py .
COPY site ./site
ENV DATA_DIR=/data PORT=8080
EXPOSE 8080
CMD ["python", "-u", "server.py"]
