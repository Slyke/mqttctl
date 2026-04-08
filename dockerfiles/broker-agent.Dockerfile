FROM eclipse-mosquitto:2.0.21 AS build

ARG RUST_VERSION=1.83.0

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/rustup/bin:$PATH

WORKDIR /workspace/broker-agent

RUN apk add --no-cache \
        build-base \
        ca-certificates \
        cmake \
        curl \
        perl \
        pkgconf \
    && curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal --default-toolchain ${RUST_VERSION}

COPY broker-agent/Cargo.toml broker-agent/Cargo.lock broker-agent/errors.json ./
COPY broker-agent/src ./src

COPY . /workspace
RUN cargo build --locked --release

FROM eclipse-mosquitto:2.0.21

COPY --from=build /workspace/broker-agent/target/release/mqttctl-broker-agent /usr/local/bin/mqttctl-broker-agent

RUN mkdir -p /mosquitto/config /mosquitto/data /etc/mqttctl

EXPOSE 1883 9001 3900 3943

CMD ["/usr/local/bin/mqttctl-broker-agent"]
