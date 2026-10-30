alter table sale_label drop constraint sale_label_printed;
alter table sale_label drop column print_count;
alter table sale_label drop column printed_at;
alter table sale_label drop column printed_tracking_number;
alter table sale_label drop column label_file_url;
