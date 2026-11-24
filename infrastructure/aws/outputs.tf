output "api_origin" {
  value = "https://${var.api_hostname}"
}
output "media_distribution" {
  value = "https://${aws_cloudfront_distribution.media.domain_name}"
}
output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}
output "migration_definition" {
  value = aws_ecs_task_definition.migrate.arn
}
output "migration_network_configuration" {
  value = jsonencode({
    awsvpcConfiguration = {
      subnets        = var.private_subnet_ids
      securityGroups = [aws_security_group.tasks.id]
      assignPublicIp = "DISABLED"
    }
  })
}
output "dead_letter_queue_url" {
  value = aws_sqs_queue.dead.url
}
