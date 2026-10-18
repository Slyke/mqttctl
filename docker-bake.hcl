// Both stages of each Dockerfile run on the target architecture so Rust,
// better-sqlite3 and argon2 are compiled for the image that contains them.
variable "IMAGE_PREFIX" {
  default = "slyke"
}
variable "VERSION" {
  default = "dev"
}
variable "BUILD_HASH" {
  default = "local"
}
variable "EXTRA_IMAGE_PREFIX" {
  default = ""
}

group "default" {
  targets = ["mqttctl", "broker-agent"]
}

target "_common" {
  context = "."
  platforms = ["linux/amd64", "linux/arm64"]
  args = {
    BUILD_HASH = BUILD_HASH
  }
}

function "image_tags" {
  params = [image]
  result = flatten([
    for prefix in compact([IMAGE_PREFIX, EXTRA_IMAGE_PREFIX]) : [
      for tag in (VERSION == "dev" ? ["dev"] : ["latest", VERSION, "${VERSION}-${BUILD_HASH}"]) :
      "${prefix}/${image}:${tag}"
    ]
  ])
}

target "mqttctl" {
  inherits = ["_common"]
  dockerfile = "dockerfiles/mqttctl.Dockerfile"
  tags = image_tags("mqttctl")
}

target "broker-agent" {
  inherits = ["_common"]
  dockerfile = "dockerfiles/broker-agent.Dockerfile"
  tags = image_tags("mqttctl-broker-agent")
}
