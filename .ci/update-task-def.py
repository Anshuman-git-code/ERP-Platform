#!/usr/bin/env python3
"""
Update an ECS task definition's container image and print cleaned JSON
for use with aws ecs register-task-definition --cli-input-json.

Usage:
  aws ecs describe-task-definition --task-definition <name> \
    --query taskDefinition --output json \
    | python3 .ci/update-task-def.py <container-name> <new-image-uri>
"""
import sys
import json

if len(sys.argv) != 3:
    print(f"Usage: {sys.argv[0]} <container-name> <new-image-uri>", file=sys.stderr)
    sys.exit(1)

container_name = sys.argv[1]
new_image = sys.argv[2]

td = json.load(sys.stdin)

# Update the image for the named container
for container in td.get("containerDefinitions", []):
    if container["name"] == container_name:
        container["image"] = new_image

# Remove read-only fields that aws ecs register-task-definition rejects
for key in [
    "taskDefinitionArn", "revision", "status",
    "registeredAt", "registeredBy",
    "requiresAttributes", "compatibilities",
]:
    td.pop(key, None)

print(json.dumps(td))
